import { fingerprint } from "../../core/secret-vault";
import { ClaudeOAuth, Identity } from "../../core/types";
import { accountsOf, ProviderContext } from "../provider";
import { fetchClaudeIdentity } from "./claude-api";
import { ClaudeSlot } from "./claude-paths";
import { readLive } from "./claude-credential-store";

/** Who owns a slot may be answered from a Keychain read this recent. */
const LOOKUP_MAX_AGE_MS = 15_000;

export interface LiveOwner {
  oauth?: ClaudeOAuth;
  accountId?: string;
  identity?: Identity;
  fallbackFile?: string;
  /**
   * Asking Anthropic whose login this is failed (network, 429, expired token). Unlike
   * "not saved", callers must not act as if the login belonged to nobody.
   */
  unresolved?: boolean;
}

export class UnresolvedLoginError extends Error {
  constructor() {
    super("Could not identify the Claude login in use yet (network or rate limit). Nothing was changed; try again shortly.");
  }
}

/**
 * Tells which saved account a slot's login belongs to. A refresh-token fingerprint match
 * is free; otherwise Anthropic is asked (the config's oauthAccount can name another
 * account than the login). A match also syncs the login into the vault, since Claude Code
 * rotates tokens and the slot always holds the newest generation.
 */
export class ClaudeLiveIndex {
  private cache = new Map<string, { fp: string; accountId?: string; identity?: Identity }>();

  constructor(private readonly ctx: ProviderContext) {}

  invalidate(dir?: string): void {
    if (dir) {
      this.cache.delete(dir);
    } else {
      this.cache.clear();
    }
  }

  /** `fresh`: read the Keychain now (callers holding the slot's locks). */
  async owner(slot: ClaudeSlot, fresh = false): Promise<LiveOwner> {
    const live = await readLive(slot, fresh ? 0 : LOOKUP_MAX_AGE_MS);
    const oauth = live.doc?.claudeAiOauth;
    if (!oauth?.refreshToken) {
      return {};
    }
    const fp = fingerprint(oauth.refreshToken);
    const cached = this.cache.get(slot.dir);
    if (cached && cached.fp === fp) {
      return { oauth, accountId: cached.accountId, identity: cached.identity, fallbackFile: live.fallbackFile };
    }

    let accountId = await this.matchByToken(fp);
    let identity: Identity | undefined;
    let unresolved = false;
    if (!accountId) {
      try {
        identity = await fetchClaudeIdentity(oauth.accessToken);
        accountId = accountsOf(this.ctx, "claude").find((a) => a.identityKey === identity!.identityKey)?.id;
      } catch {
        unresolved = true;
      }
    }
    if (accountId) {
      await this.sync(accountId, oauth);
    }
    if (!unresolved) {
      this.cache.set(slot.dir, { fp, accountId, identity });
    }
    return { oauth, accountId, identity, fallbackFile: live.fallbackFile, unresolved };
  }

  /**
   * Stores a newer generation of a saved account's login. An older one (read before a
   * slow network call, while a switch parked a fresher one) is never written over it.
   */
  async sync(accountId: string, oauth: ClaudeOAuth): Promise<void> {
    const stored = await this.ctx.vault.get(accountId);
    if (stored?.kind === "claude") {
      if (stored.oauth.refreshToken === oauth.refreshToken && stored.oauth.accessToken === oauth.accessToken) {
        return;
      }
      if ((stored.oauth.expiresAt ?? 0) > (oauth.expiresAt ?? 0)) {
        return;
      }
    }
    await this.ctx.vault.set(accountId, { kind: "claude", oauth });
  }

  private async matchByToken(fp: string): Promise<string | undefined> {
    for (const account of accountsOf(this.ctx, "claude")) {
      const secret = await this.ctx.vault.get(account.id);
      if (secret?.kind === "claude" && fingerprint(secret.oauth.refreshToken) === fp) {
        return account.id;
      }
    }
    return undefined;
  }
}
