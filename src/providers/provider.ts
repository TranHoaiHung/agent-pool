import * as path from "path";
import { withAccountLock } from "../core/dir-lock";
import { poolHome, PoolStore } from "../core/pool-store";
import { SecretVault } from "../core/secret-vault";
import { AccountMeta, AccountSecret, Identity, ProviderId, UsageSnapshot } from "../core/types";

export interface ProviderContext {
  pool: PoolStore;
  vault: SecretVault;
  log(message: string): void;
  /** Saves a login nobody enrolled, so a switch never throws a login away. */
  enroll(provider: ProviderId, secret: AccountSecret, identity: Identity): Promise<AccountMeta>;
}

export interface SwitchOutcome {
  /** The change needs a window reload (or a tool restart) to take effect. */
  needsReload: boolean;
  /** Until reloaded, the tool keeps spending the previous account: say so loudly. */
  mustReload?: boolean;
  notes: string[];
}

export interface SwitchOptions {
  /** Claude, VS Code only: the account is the terminal's; exchange the two accounts. */
  swapWithTerminal?: boolean;
}

/** The account is in use somewhere else (the terminal) and cannot be live in two places. */
export class HeldElsewhereError extends Error {
  constructor(readonly where: string) {
    super(`This account is in use by the ${where}.`);
  }
}

/** A place a provider's login lives, for display (e.g. "Terminal" for Claude's global slot). */
export interface Place {
  label: string;
  accountId?: string;
  email?: string;
}

export interface Provider {
  readonly id: ProviderId;
  /** The account VS Code is using for this tool right now. */
  activeAccountId(): Promise<string | undefined>;
  /** Every place a login of this tool lives, for the tooltip. */
  places(): Promise<Place[]>;
  /** The login VS Code currently uses, for "Save current". */
  captureCurrent(): Promise<{ secret: AccountSecret; identity: Identity } | undefined>;
  /** Reads usage, renewing and syncing the login as needed. */
  usage(account: AccountMeta): Promise<UsageSnapshot>;
  switchTo(account: AccountMeta, options?: SwitchOptions): Promise<SwitchOutcome>;
  /** An account live in another place this tool's switches must not take (the terminal's). */
  heldElsewhere?(): Promise<string | undefined>;
  /** Signs in to another account without touching the one in use. */
  login(cancel: { isCancellationRequested: boolean }): Promise<{ secret: AccountSecret; identity: Identity }>;
  /** Forget cached knowledge of live logins (after an external change). */
  invalidate(): void;
}

export function accountsOf(ctx: ProviderContext, provider: ProviderId): AccountMeta[] {
  return ctx.pool.get().accounts.filter((a) => a.provider === provider);
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  cancel: { isCancellationRequested: boolean },
  timeoutMs: number,
  everyMs = 2_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancel.isCancellationRequested) {
      throw new Error("Login cancelled.");
    }
    const value = await probe().catch(() => undefined);
    if (value !== undefined) {
      return value;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error("Login timed out.");
}

/** Runs `action` holding the cross-window lock of one account's parked login. */
export function lockAccount<T>(accountId: string, action: () => Promise<T>): Promise<T> {
  return withAccountLock(path.join(poolHome(), "locks"), accountId, action);
}
