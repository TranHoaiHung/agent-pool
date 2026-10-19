import { PoolStore } from "./core/pool-store";
import { move } from "./core/priority";
import { newAccountId, SecretVault } from "./core/secret-vault";
import { AccountMeta, AccountSecret, Identity, PROVIDERS, ProviderId } from "./core/types";
import { Provider, ProviderContext, SwitchOutcome } from "./providers/provider";

/** What the UI and the poller use: accounts, their order, and switching. */
export class AccountService {
  readonly providers = new Map<ProviderId, Provider>();
  /** Account VS Code uses per tool, as last read. */
  private active = new Map<ProviderId, string | undefined>();
  private held = new Map<ProviderId, string | undefined>();
  private reloadChecks = new Map<ProviderId, () => boolean>();
  private terminal = new Map<ProviderId, string | undefined>();
  /** Why auto switch is not switching right now, for the tooltip. */
  readonly autoNote = new Map<ProviderId, string>();
  private switching = new Set<ProviderId>();
  private listeners: Array<() => void> = [];
  private switchListeners: Array<(provider: ProviderId) => void> = [];
  private autoSaveListeners: Array<(meta: AccountMeta) => void> = [];
  private autoSaveTried = new Map<ProviderId, number>();
  /** Reads settings without a vscode import (keeps this class testable). */
  settings?: { autoSaveLogins(): boolean };
  /** When this window's extension host started (a reload restarts it). */
  private readonly startedAt = Date.now();

  constructor(
    readonly pool: PoolStore,
    readonly vault: SecretVault,
    readonly log: (message: string) => void
  ) {}

  /** The context handed to providers. */
  providerContext(): ProviderContext {
    return {
      pool: this.pool,
      vault: this.vault,
      log: this.log,
      enroll: (provider, secret, identity) => this.enroll(provider, secret, identity),
    };
  }

  register(provider: Provider): void {
    this.providers.set(provider.id, provider);
  }

  /** Called after every successful switch, manual or automatic. */
  onSwitched(listener: (provider: ProviderId) => void): void {
    this.switchListeners.push(listener);
  }

  onActiveChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /**
   * This window was started before a switch that needs a reload: the tool here still runs
   * the previous account, so what AgentPool calls "in use" is not what is being spent.
   */
  pendingReload(provider: ProviderId): boolean {
    const exact = this.reloadChecks.get(provider);
    if (exact) {
      return exact(); // the provider knows precisely whether this window runs a stale setup
    }
    const last = this.pool.get().lastSwitch[provider];
    return (last?.reloadAt ?? 0) > this.startedAt;
  }

  /** A precise "this window must reload" test for a provider (Claude: the VS Code slot setting). */
  setReloadCheck(provider: ProviderId, check: () => boolean): void {
    this.reloadChecks.set(provider, check);
  }

  /** The account another place holds (the terminal's, in VS Code only mode): never switched to automatically. */
  heldElsewhere(provider: ProviderId): string | undefined {
    return this.held.get(provider);
  }

  /** The account the terminal uses (Claude), as last read. */
  terminalAccount(provider: ProviderId): string | undefined {
    return this.terminal.get(provider);
  }

  activeId(provider: ProviderId): string | undefined {
    return this.active.get(provider);
  }

  account(id: string): AccountMeta | undefined {
    return this.pool.get().accounts.find((a) => a.id === id);
  }

  /** Re-reads which account each tool uses. */
  async refreshActive(): Promise<void> {
    let changed = false;
    for (const id of PROVIDERS) {
      const provider = this.providers.get(id);
      let value = await provider?.activeAccountId().catch((e: Error) => {
        this.log(`[${id}] could not read the login in use: ${e.message}`);
        return this.active.get(id);
      });
      if (value === undefined && provider) {
        value = (await this.autoSave(id))?.id;
      }
      this.held.set(id, await provider?.heldElsewhere?.().catch(() => undefined));
      this.terminal.set(id, await provider?.terminalAccountId?.().catch(() => undefined));
      if (value !== this.active.get(id)) {
        this.active.set(id, value);
        changed = true;
      }
    }
    if (changed) {
      this.listeners.forEach((l) => l());
    }
  }

  /**
   * Saves the login a tool uses when nobody saved it yet (signed in with /login, `codex login`,
   * …), so people never need "Save current login". Skips logins the person removed, and is
   * attempted at most once a minute per tool (it may ask Anthropic whose login it is).
   */
  private async autoSave(provider: ProviderId): Promise<AccountMeta | undefined> {
    const enabled = this.settings?.autoSaveLogins() ?? true;
    const last = this.autoSaveTried.get(provider) ?? 0;
    if (!enabled || Date.now() - last < 60_000) {
      return undefined;
    }
    this.autoSaveTried.set(provider, Date.now());
    try {
      const current = await this.providers.get(provider)!.captureCurrent();
      if (!current || (this.pool.get().removedIdentities ?? []).includes(current.identity.identityKey)) {
        return undefined;
      }
      const meta = await this.enroll(provider, current.secret, current.identity);
      this.log(`[${provider}] auto-saved the login in use: ${meta.label}`);
      this.autoSaveListeners.forEach((l) => l(meta));
      return meta;
    } catch (e) {
      this.log(`[${provider}] auto-save skipped: ${(e as Error).message}`);
      return undefined;
    }
  }

  onAutoSaved(listener: (meta: AccountMeta) => void): void {
    this.autoSaveListeners.push(listener);
  }

  /** Saves a login, or updates the saved one with the same identity. */
  async enroll(provider: ProviderId, secret: AccountSecret, identity: Identity): Promise<AccountMeta> {
    let meta: AccountMeta | undefined;
    await this.pool.mutate((data) => {
      meta = data.accounts.find((a) => a.provider === provider && a.identityKey === identity.identityKey);
      if (meta) {
        meta.email = identity.email ?? meta.email;
        meta.orgName = identity.orgName ?? meta.orgName;
        meta.plan = identity.plan ?? meta.plan;
        meta.extra = identity.raw ?? meta.extra;
        meta.needsReauth = false;
        return;
      }
      const sameProvider = data.accounts.filter((a) => a.provider === provider);
      meta = {
        id: newAccountId(),
        provider,
        label: defaultLabel(identity, sameProvider),
        email: identity.email,
        orgName: identity.orgName,
        plan: identity.plan,
        identityKey: identity.identityKey,
        inRotation: true,
        addedAt: Date.now(),
        extra: identity.raw,
      };
      data.accounts.push(meta);
      data.order[provider] = [...data.order[provider], meta.id];
    });
    await this.vault.set(meta!.id, secret);
    this.providers.get(provider)?.invalidate();
    return meta!;
  }

  async saveCurrent(provider: ProviderId): Promise<AccountMeta | undefined> {
    const current = await this.providers.get(provider)!.captureCurrent();
    if (!current) {
      return undefined;
    }
    await this.pool.mutate((data) => {
      data.removedIdentities = (data.removedIdentities ?? []).filter((k) => k !== current.identity.identityKey);
    });
    const meta = await this.enroll(provider, current.secret, current.identity);
    await this.refreshActive();
    return meta;
  }

  async addAccount(provider: ProviderId, cancel: { isCancellationRequested: boolean }): Promise<AccountMeta> {
    const result = await this.providers.get(provider)!.login(cancel);
    return this.enroll(provider, result.secret, result.identity);
  }

  async switchTo(id: string, automatic: boolean, reason?: "threshold" | "preferred"): Promise<SwitchOutcome> {
    const account = this.account(id);
    if (!account) {
      throw new Error("Unknown account.");
    }
    if (this.switching.has(account.provider)) {
      throw new Error("A switch is already under way.");
    }
    this.switching.add(account.provider);
    try {
      const fromId = this.active.get(account.provider);
      const previous = this.pool.get().lastSwitch[account.provider];
      const outcome = await this.providers.get(account.provider)!.switchTo(account);
      await this.pool.mutate((data) => {
        data.lastSwitch[account.provider] = {
          at: Date.now(),
          fromId,
          toId: id,
          automatic,
          reason,
          // Sticky: a later switch that needs no reload does not undo an earlier one's need.
          reloadAt: outcome.needsReload ? Date.now() : previous?.reloadAt,
        };
        delete data.noticeKeys[account.provider]; // a later exhaustion is news again
      });
      this.log(`[${account.provider}] ${automatic ? "auto-" : ""}switched ${fromId ?? "?"} → ${id}. ${outcome.notes.join(" ")}`);
      await this.refreshActive();
      this.switchListeners.forEach((l) => l(account.provider));
      return outcome;
    } finally {
      this.switching.delete(account.provider);
    }
  }

  /** Claude only: puts the account in the terminal's login and pins it there. */
  async pinToTerminal(id: string): Promise<string[]> {
    const account = this.account(id);
    const provider = this.providers.get("claude") as (Provider & { setTerminalAccount?(a: AccountMeta): Promise<string[]> }) | undefined;
    if (!account || account.provider !== "claude" || !provider?.setTerminalAccount) {
      throw new Error("Only a Claude Code account can be pinned to the terminal.");
    }
    const notes = await provider.setTerminalAccount(account);
    await this.pool.mutate((d) => {
      d.terminalPin = id;
    });
    provider.invalidate();
    await this.refreshActive();
    this.log(`[claude] terminal pinned to ${account.label}`);
    return notes;
  }

  async unpinTerminal(): Promise<void> {
    await this.pool.mutate((d) => {
      delete d.terminalPin;
    });
    await this.refreshActive();
  }

  async remove(id: string): Promise<void> {
    await this.pool.mutate((data) => {
      const removed = data.accounts.find((a) => a.id === id);
      if (removed) {
        data.removedIdentities = [...new Set([...(data.removedIdentities ?? []), removed.identityKey])];
      }
      data.accounts = data.accounts.filter((a) => a.id !== id);
      if (data.terminalPin === id) {
        delete data.terminalPin;
      }
      for (const p of PROVIDERS) {
        data.order[p] = data.order[p].filter((x) => x !== id);
      }
      delete data.usage[id];
    });
    await this.vault.delete(id);
  }

  async update(id: string, change: (a: AccountMeta) => void): Promise<void> {
    await this.pool.mutate((data) => {
      const account = data.accounts.find((a) => a.id === id);
      if (account) {
        change(account);
      }
    });
  }

  async move(id: string, delta: number): Promise<void> {
    await this.pool.mutate((data) => move(data, id, delta));
  }
}

/** The email's local part, or `local@domain` (no TLD) when another account already uses it. */
export function defaultLabel(identity: Identity, others: AccountMeta[]): string {
  const [local, domain] = identity.email?.split("@") ?? [];
  if (!local) {
    return `Account ${String.fromCharCode(65 + others.length)}`;
  }
  const taken = new Set(others.map((a) => a.label));
  if (!taken.has(local)) {
    return local;
  }
  const qualified = domain ? `${local}@${domain.split(".")[0]}` : local;
  return taken.has(qualified) ? identity.email! : qualified;
}
