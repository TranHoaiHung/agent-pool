import * as fs from "fs";
import { refreshLocks, withLocks, writeLock } from "../../core/dir-lock";
import { AccountMeta, ClaudeOAuth, Identity } from "../../core/types";
import { HttpError } from "../http";
import { lockAccount, ProviderContext } from "../provider";
import { fetchClaudeIdentity, isExpiring, refreshClaude } from "./claude-api";
import { clearLive, credentialFile, readLive, stowFallbackFile, writeLive } from "./claude-credential-store";
import { ClaudeLiveIndex, UnresolvedLoginError } from "./claude-live-index";
import { ClaudeSlot } from "./claude-paths";

const LOCK_TIMEOUT_MS = 20_000;

/**
 * Every change to a Claude Code slot. Each runs under Claude Code's own refresh and write
 * locks, re-reads the slot inside them, and parks the outgoing login in the vault before
 * anything overwrites it, so no single-use refresh token is ever lost or spent twice.
 */
export class ClaudeSlotWriter {
  constructor(
    private readonly ctx: ProviderContext,
    private readonly index: ClaudeLiveIndex
  ) {}

  /** Puts `account`'s parked login into `slot`. Returns notes for the user. */
  async swapIn(slot: ClaudeSlot, account: AccountMeta): Promise<string[]> {
    // Already there: writing the vault copy over the live one could put back a spent token.
    let before = await this.index.owner(slot);
    if (before.unresolved && before.oauth && isExpiring(before.oauth)) {
      await this.renewUnidentified(slot);
      before = await this.index.owner(slot);
    }
    if (before.unresolved) {
      throw new UnresolvedLoginError();
    }
    if (before.accountId === account.id) {
      return [];
    }

    const incoming = await this.freshParked(account);
    let fallbackFile: string | undefined;
    let wrote = false;
    await withLocks([...refreshLocks(slot.dir), writeLock(slot.dir)], LOCK_TIMEOUT_MS, async () => {
      const live = await readLive(slot);
      const outgoing = live.doc?.claudeAiOauth;
      if (outgoing?.refreshToken === incoming.refreshToken) {
        return; // became live meanwhile
      }
      if (outgoing?.refreshToken) {
        await this.park(slot, outgoing);
      }
      await writeLive(slot, { ...(live.doc ?? {}), claudeAiOauth: incoming });
      wrote = true;
    });
    this.index.invalidate(slot.dir);
    if (!wrote) {
      return [];
    }

    const notes: string[] = [];
    // On macOS a plaintext file behind the Keychain keeps sessions on their old login.
    const file = credentialFile(slot);
    fallbackFile = process.platform === "darwin" && fs.existsSync(file) ? file : undefined;
    if (fallbackFile) {
      const moved = stowFallbackFile(fallbackFile);
      notes.push(`Moved the plaintext fallback login aside (${moved}) so running sessions follow the switch.`);
    }
    this.writeOauthAccount(slot, account);
    return notes;
  }

  /** Parks the slot's login and empties the slot (the VS Code slot being retired). */
  async retire(slot: ClaudeSlot): Promise<void> {
    await withLocks([...refreshLocks(slot.dir), writeLock(slot.dir)], LOCK_TIMEOUT_MS, async () => {
      const live = await readLive(slot);
      if (live.doc?.claudeAiOauth?.refreshToken) {
        await this.park(slot, live.doc.claudeAiOauth);
      }
      await clearLive(slot);
    });
    this.index.invalidate(slot.dir);
  }

  /** Renews a login that is live in `slot`, the way Claude Code would, and returns it. */
  async renewLive(slot: ClaudeSlot, accountId: string): Promise<ClaudeOAuth> {
    return withLocks(refreshLocks(slot.dir), LOCK_TIMEOUT_MS, async () => {
      const live = await readLive(slot);
      const current = live.doc?.claudeAiOauth;
      if (!current) {
        throw new Error("The slot lost its login while renewing.");
      }
      if (!isExpiring(current)) {
        return current; // a Claude Code session renewed it meanwhile
      }
      const renewed = await refreshClaude(current);
      // The old refresh token is spent now: keep the new one in the vault before anything
      // else can fail (a locked Keychain, a busy write lock).
      await this.index.sync(accountId, renewed);
      await withLocks([writeLock(slot.dir)], LOCK_TIMEOUT_MS, async () => {
        const again = await readLive(slot);
        if (again.doc?.claudeAiOauth?.refreshToken !== current.refreshToken) {
          return; // changed under us
        }
        await writeLive(slot, { ...again.doc, claudeAiOauth: renewed });
      });
      this.index.invalidate(slot.dir);
      return renewed;
    });
  }

  /**
   * Renews an expired login nobody saved, so it can be identified (Anthropic refuses an
   * expired access token). Done under the slot's locks exactly as Claude Code renews it.
   */
  async renewUnidentified(slot: ClaudeSlot): Promise<void> {
    await withLocks(refreshLocks(slot.dir), LOCK_TIMEOUT_MS, async () => {
      const current = (await readLive(slot)).doc?.claudeAiOauth;
      if (!current || !isExpiring(current)) {
        return;
      }
      const renewed = await refreshClaude(current);
      await withLocks([writeLock(slot.dir)], LOCK_TIMEOUT_MS, async () => {
        const again = await readLive(slot);
        if (again.doc?.claudeAiOauth?.refreshToken === current.refreshToken) {
          await writeLive(slot, { ...again.doc, claudeAiOauth: renewed });
        }
      });
    });
    this.index.invalidate(slot.dir);
  }

  /** The account's parked login, renewed under its cross-window lock when expiring. */
  async freshParked(account: AccountMeta): Promise<ClaudeOAuth> {
    return lockAccount(account.id, async () => {
      const secret = await this.ctx.vault.get(account.id);
      if (secret?.kind !== "claude") {
        throw new Error(`No saved login for ${account.label}. Sign in to it again.`);
      }
      if (!isExpiring(secret.oauth)) {
        return secret.oauth;
      }
      const renewed = await refreshClaude(secret.oauth);
      await this.ctx.vault.set(account.id, { kind: "claude", oauth: renewed });
      return renewed;
    });
  }

  /**
   * Stores the outgoing login under its account, enrolling it when nobody saved it. Runs
   * inside the slot's refresh lock, so renewing an expired outgoing login to identify it
   * is safe. When it cannot be identified at all the switch is aborted: nothing written.
   */
  private async park(slot: ClaudeSlot, oauth: ClaudeOAuth): Promise<void> {
    this.index.invalidate(slot.dir);
    const owner = await this.index.owner(slot);
    if (owner.accountId) {
      await this.index.sync(owner.accountId, oauth);
      return;
    }
    let login = oauth;
    let identity: Identity | undefined = owner.identity;
    if (!identity) {
      try {
        identity = await fetchClaudeIdentity(login.accessToken);
      } catch (e) {
        if (!(e instanceof HttpError && e.unauthorized)) {
          throw new UnresolvedLoginError();
        }
        login = await refreshClaude(login);
        identity = await fetchClaudeIdentity(login.accessToken).catch(() => undefined);
        if (!identity) {
          // Keep the renewed login in the slot so its old token's spending is not lost.
          const doc = (await readLive(slot)).doc ?? {};
          await writeLive(slot, { ...doc, claudeAiOauth: login });
          throw new UnresolvedLoginError();
        }
      }
    }
    const meta = await this.ctx.enroll("claude", { kind: "claude", oauth: login }, identity);
    this.ctx.log(`Saved the outgoing Claude login as "${meta.label}" before switching.`);
  }

  /** Points Claude Code's cached `oauthAccount` at the account, so /status names it, and
   * drops its usage cache of the previous account. */
  private writeOauthAccount(slot: ClaudeSlot, account: AccountMeta): void {
    const fields = account.extra;
    if (!fields || !fs.existsSync(slot.configFile)) {
      return;
    }
    try {
      const mtime = fs.statSync(slot.configFile).mtimeMs;
      const config = JSON.parse(fs.readFileSync(slot.configFile, "utf8")) as Record<string, unknown>;
      const previous = (config.oauthAccount as Record<string, unknown> | undefined) ?? {};
      if (previous.accountUuid === fields.accountUuid) {
        return;
      }
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) {
          next[k] = v;
        }
      }
      config.oauthAccount = next;
      // Claude Code stamps this cache with the config's account but fills it from the login
      // its session holds; kept, it would show the previous account's numbers under this one.
      delete config.cachedUsageUtilization;
      const text = JSON.stringify(config, null, 2);
      // Claude Code writes this file often; never replace a write that landed meanwhile.
      if (fs.statSync(slot.configFile).mtimeMs !== mtime) {
        return;
      }
      const tmp = `${slot.configFile}.agent-pool.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, slot.configFile);
    } catch (e) {
      this.ctx.log(`Could not update oauthAccount in ${slot.configFile}: ${(e as Error).message}`);
    }
  }
}
