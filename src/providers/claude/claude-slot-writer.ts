import * as fs from "fs";
import { replaceFile } from "../../core/fs-utils";
import { refreshLocks, withLocks, writeLock } from "../../core/dir-lock";
import { DEFAULT_GROUP } from "../../core/groups";
import { AccountMeta, ClaudeOAuth, Identity } from "../../core/types";
import { HttpError } from "../http";
import { lockAccount, ProviderContext } from "../provider";
import { fetchClaudeIdentity, isExpiring, refreshClaude } from "./claude-api";
import { clearLive, credentialFile, readLive, stowFallbackFile, writeLive } from "./claude-credential-store";
import { ClaudeLiveIndex, LiveOwner, UnresolvedLoginError } from "./claude-live-index";
import { ClaudeSlot } from "./claude-paths";

const LOCK_TIMEOUT_MS = 20_000;
/** A login shared by two slots is renewed this long before it expires (Claude Code waits for 5 min). */
const MIRROR_RENEW_MS = 30 * 60_000;

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
    const { owner: before, dead } = await this.identify(slot);
    if (before.unresolved && !dead) {
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
      if (outgoing?.refreshToken && outgoing.refreshToken !== dead) {
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

  /**
   * Who holds `slot`, renewing its login first when that is the only way to tell (expiring, or
   * Anthropic refused its access token before its expiry). `dead`: the refresh token of a login
   * whose sign-in ended (time limit, revoked, organization block): replacing it loses nothing.
   * Still `unresolved` without `dead`: unknown for now (network, rate limit) — do not act.
   */
  async identify(slot: ClaudeSlot): Promise<{ owner: LiveOwner; dead?: string }> {
    const owner = await this.index.owner(slot, true);
    const stale = owner.oauth;
    if (!owner.unresolved || !stale || !(isExpiring(stale) || owner.rejected)) {
      return { owner };
    }
    try {
      await this.renewUnidentified(slot, owner.rejected);
      const again = await this.index.owner(slot, true);
      // Refused even freshly renewed: unusable.
      return { owner: again, dead: owner.rejected && again.unresolved && again.rejected ? again.oauth?.refreshToken : undefined };
    } catch (e) {
      if (!(e instanceof HttpError && e.deadLogin)) {
        throw e;
      }
      return { owner, dead: stale.refreshToken };
    }
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

  /**
   * Renews a login that is live in `slot`, the way Claude Code would, and returns it. `others`:
   * every other slot, so an ended sign-in is replaced only by a saved login no slot holds.
   */
  async renewLive(slot: ClaudeSlot, accountId: string, others: ClaudeSlot[] = []): Promise<ClaudeOAuth> {
    return withLocks(refreshLocks(slot.dir), LOCK_TIMEOUT_MS, async () => {
      const live = await readLive(slot);
      const current = live.doc?.claudeAiOauth;
      if (!current) {
        throw new Error("The slot lost its login while renewing.");
      }
      if (!isExpiring(current)) {
        return current; // a Claude Code session renewed it meanwhile
      }
      let renewed: ClaudeOAuth;
      try {
        renewed = await refreshClaude(current);
      } catch (e) {
        // The slot's sign-in ended. When the account was signed in again since (Add account),
        // that newer login replaces the dead copy here instead of failing on every read.
        // "reused" means a newer copy lives somewhere else: never replace on that.
        const ended = e instanceof HttpError && e.deadLogin && !/reused/i.test(e.message);
        const newer = ended && !(await this.heldBy(others, accountId)) ? await this.renewSaved(accountId, current.refreshToken) : undefined;
        if (!newer) {
          throw e;
        }
        this.ctx.log(`The ${slot.name} slot held an ended sign-in; using the newer one saved for this account.`);
        renewed = newer;
      }
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
  async renewUnidentified(slot: ClaudeSlot, force = false): Promise<void> {
    await withLocks(refreshLocks(slot.dir), LOCK_TIMEOUT_MS, async () => {
      const current = (await readLive(slot)).doc?.claudeAiOauth;
      // `force`: Anthropic refused its access token before its expiry (revoked): renew anyway.
      if (!current || (!force && !isExpiring(current))) {
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

  /**
   * The same account live in several slots (the terminal's account used by VS Code too): keeps
   * one generation of its login everywhere. It renews early (well before Claude Code's own
   * 5-minute margin), holding every slot's refresh lock, and writes the result to all slots,
   * so no Claude Code process ever spends a refresh token another slot still holds.
   * Returns the shared login, or undefined when the slots no longer hold the same account.
   */
  async keepMirrored(slots: ClaudeSlot[], accountId: string): Promise<ClaudeOAuth | undefined> {
    return withLocks(slots.flatMap((s) => refreshLocks(s.dir)), LOCK_TIMEOUT_MS, async () => {
      // Re-checked under the locks: a switch may have moved one slot to another account since.
      const owners = [];
      for (const s of slots) {
        owners.push(await this.index.owner(s, true)); // fresh read; identity cached by token fingerprint
      }
      if (owners.some((o) => o.accountId !== accountId || !o.oauth?.refreshToken)) {
        return undefined;
      }
      const current = owners.map((o) => o.oauth);
      let newest = current.reduce((a, b) => ((b!.expiresAt ?? 0) > (a!.expiresAt ?? 0) ? b : a))!;
      if (typeof newest.expiresAt === "number" && newest.expiresAt - MIRROR_RENEW_MS < Date.now()) {
        newest = await refreshClaude(newest);
        await this.index.sync(accountId, newest); // the old refresh token is spent: vault first
      }
      for (let i = 0; i < slots.length; i++) {
        const had = current[i]!;
        if (had.refreshToken === newest.refreshToken && had.accessToken === newest.accessToken) {
          continue;
        }
        await withLocks([writeLock(slots[i].dir)], LOCK_TIMEOUT_MS, async () => {
          const again = await readLive(slots[i]);
          if (again.doc?.claudeAiOauth?.refreshToken !== had.refreshToken) {
            return; // changed under us: the next pass reconciles
          }
          await writeLive(slots[i], { ...again.doc, claudeAiOauth: newest });
        });
        this.index.invalidate(slots[i].dir);
      }
      await this.index.sync(accountId, newest);
      return newest;
    });
  }

  /** The account's parked login, renewed under its cross-window lock when expiring. */
  async freshParked(account: AccountMeta): Promise<ClaudeOAuth> {
    const oauth = await this.renewSaved(account.id);
    if (!oauth) {
      throw new Error(`No saved login for ${account.label}. Sign in to it again.`);
    }
    return oauth;
  }

  /** Whether one of `slots` holds the account's saved login (renewing it would spend their token). */
  private async heldBy(slots: ClaudeSlot[], accountId: string): Promise<boolean> {
    const saved = await this.ctx.vault.get(accountId);
    if (saved?.kind !== "claude") {
      return false;
    }
    for (const s of slots) {
      if ((await readLive(s)).doc?.claudeAiOauth?.refreshToken === saved.oauth.refreshToken) {
        return true;
      }
    }
    return false;
  }

  /** The saved login, renewed under its cross-window lock when expiring; undefined when there is
   * none (or it is still the one with refresh token `unless`). */
  private async renewSaved(accountId: string, unless?: string): Promise<ClaudeOAuth | undefined> {
    return lockAccount(accountId, async () => {
      const secret = await this.ctx.vault.get(accountId);
      if (secret?.kind !== "claude" || secret.oauth.refreshToken === unless) {
        return undefined;
      }
      if (!isExpiring(secret.oauth)) {
        return secret.oauth;
      }
      const renewed = await refreshClaude(secret.oauth);
      await this.ctx.vault.set(accountId, { kind: "claude", oauth: renewed });
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
    const owner = await this.index.owner(slot, true);
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
    // The terminal's login is nobody's group login: it joins the default group.
    const meta = await this.ctx.enroll("claude", { kind: "claude", oauth: login }, identity, slot.name === "global" ? DEFAULT_GROUP : undefined);
    this.ctx.log(`Saved the outgoing Claude login as "${meta.label}" before switching.`);
  }

  /** Points Claude Code's cached `oauthAccount` at the account, so /status names it, and
   * drops its usage cache of the previous account. */
  private writeOauthAccount(slot: ClaudeSlot, account: AccountMeta): void {
    const fields = account.extra;
    if (!fields || !fs.existsSync(slot.configFile)) {
      return;
    }
    // Claude Code rewrites this file often (and Windows locks it while it does): a write that
    // lost the race is retried on the fresh file, a few times.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const mtime = fs.statSync(slot.configFile).mtimeMs;
        const config = JSON.parse(fs.readFileSync(slot.configFile, "utf8")) as Record<string, unknown>;
        const previous = (config.oauthAccount as Record<string, unknown> | undefined) ?? {};
        if (previous.accountUuid === fields.accountUuid && !config.cachedUsageUtilization) {
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
        if (fs.statSync(slot.configFile).mtimeMs !== mtime) {
          continue; // changed while we read it: start over on the newer content
        }
        const tmp = `${slot.configFile}.agent-pool.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
        replaceFile(tmp, slot.configFile);
        return;
      } catch (e) {
        if (attempt === 4) {
          this.ctx.log(`Could not update oauthAccount in ${slot.configFile}: ${(e as Error).message}`);
        }
      }
    }
  }

}
