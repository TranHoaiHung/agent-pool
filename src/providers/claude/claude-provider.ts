import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { poolHome } from "../../core/pool-store";
import { AccountMeta, UsageSnapshot } from "../../core/types";
import { cliTerminal } from "../cli-locator";
import { HttpError } from "../http";
import { Place, Provider, ProviderContext, SwitchOutcome, waitFor } from "../provider";
import { fetchClaudeIdentity, fetchClaudeUsage, isExpiring } from "./claude-api";
import { clearLive, readLive } from "./claude-credential-store";
import { ClaudeLiveIndex, UnresolvedLoginError } from "./claude-live-index";
import { ClaudeSlot, findClaudeBinary, globalSlot, slotForDir, vscodeSlot } from "./claude-paths";
import { ClaudeSlotWriter } from "./claude-slot-writer";
import { VscodeScope } from "./vscode-scope";

/**
 * Claude Code accounts. Two slots: the global one (Keychain `Claude Code-credentials`,
 * used by `claude` in any terminal) and AgentPool's VS Code slot. By default a switch
 * moves only VS Code; with `claude.switchTerminalToo` it moves the global slot.
 */
export class ClaudeProvider implements Provider {
  readonly id = "claude" as const;
  private readonly index: ClaudeLiveIndex;
  private readonly writer: ClaudeSlotWriter;

  constructor(
    private readonly ctx: ProviderContext,
    readonly scope: VscodeScope
  ) {
    this.index = new ClaudeLiveIndex(ctx);
    this.writer = new ClaudeSlotWriter(ctx, this.index);
  }

  invalidate(): void {
    this.index.invalidate();
  }

  terminalToo(): boolean {
    return vscode.workspace.getConfiguration("agentPool").get<boolean>("claude.switchTerminalToo") ?? false;
  }

  /** The slot Claude Code inside VS Code reads. */
  vscodeTarget(): ClaudeSlot {
    return this.scope.isActive() ? vscodeSlot() : globalSlot();
  }

  async activeAccountId(): Promise<string | undefined> {
    return (await this.index.owner(this.vscodeTarget())).accountId;
  }

  async places(): Promise<Place[]> {
    const describe = async (label: string, slot: ClaudeSlot): Promise<Place> => {
      const o = await this.index.owner(slot).catch(() => ({ accountId: undefined, identity: undefined }));
      return { label, accountId: o.accountId, email: o.identity?.email };
    };
    if (!this.scope.isActive()) {
      return [await describe("VS Code + Terminal", globalSlot())];
    }
    return [await describe("VS Code", vscodeSlot()), await describe("Terminal", globalSlot())];
  }

  async captureCurrent() {
    const owner = await this.index.owner(this.vscodeTarget());
    if (!owner.oauth) {
      return undefined;
    }
    let oauth = owner.oauth;
    if (isExpiring(oauth)) {
      // Renew through the slot so Claude Code and the vault stay on one generation.
      oauth = owner.accountId ? await this.writer.renewLive(this.vscodeTarget(), owner.accountId) : oauth;
    }
    const identity = owner.identity ?? (await fetchClaudeIdentity(oauth.accessToken));
    return { secret: { kind: "claude" as const, oauth }, identity };
  }

  async usage(account: AccountMeta): Promise<UsageSnapshot> {
    const token = await this.accessToken(account);
    try {
      return await fetchClaudeUsage(token);
    } catch (e) {
      if (e instanceof HttpError && e.unauthorized) {
        this.index.invalidate();
      }
      throw e;
    }
  }

  /** VS Code only, slot in use: the terminal's account, which VS Code must not also use. */
  /** Nothing is withheld from VS Code: the terminal's account can be shared (kept in sync). */
  async heldElsewhere(): Promise<string | undefined> {
    return undefined;
  }

  /** The account the terminal's `claude` uses (the system login), for display. */
  async terminalAccountId(): Promise<string | undefined> {
    return (await this.index.owner(globalSlot())).accountId;
  }

  /** The account pinned to the terminal, if any (and still saved). */
  terminalPin(): string | undefined {
    const data = this.ctx.pool.get();
    return data.accounts.some((a) => a.id === data.terminalPin) ? data.terminalPin : undefined;
  }

  /** The two slots when they hold the same account (VS Code sharing the terminal's account). */
  private async sharedAccount(): Promise<string | undefined> {
    if (!this.scope.isActive()) {
      return undefined;
    }
    const [terminal, vscodeOwner] = [await this.index.owner(globalSlot()), await this.index.owner(vscodeSlot())];
    return terminal.accountId && terminal.accountId === vscodeOwner.accountId ? terminal.accountId : undefined;
  }

  /** Called every minute (leader): keeps a shared account's two copies on one generation. */
  async maintain(): Promise<void> {
    const shared = await this.sharedAccount();
    if (shared) {
      await this.writer.keepMirrored([globalSlot(), vscodeSlot()], shared);
    }
  }

  /** Makes sure the vault holds the newest generation of a login live in `slot`. */
  private async freshFrom(slot: ClaudeSlot, account: AccountMeta): Promise<void> {
    const owner = await this.index.owner(slot, true);
    if (owner.accountId === account.id && owner.oauth) {
      // Renew through the slot (its refresh lock) rather than from the vault copy: a refresh
      // from the vault would spend the token the slot still holds.
      const oauth = isExpiring(owner.oauth) ? await this.writer.renewLive(slot, account.id) : owner.oauth;
      await this.index.sync(account.id, oauth);
    }
  }

  /**
   * Puts `account` in the terminal's login (the system one every `claude` reads), parking what
   * was there. When VS Code uses it too, both copies are kept in sync.
   */
  async setTerminalAccount(account: AccountMeta): Promise<string[]> {
    if (this.scope.isActive()) {
      await this.freshFrom(vscodeSlot(), account);
    }
    return this.writer.swapIn(globalSlot(), account);
  }

  async switchTo(account: AccountMeta): Promise<SwitchOutcome> {
    const notes: string[] = [];
    const scopeActive = this.scope.isActive();

    // A pinned terminal account is never moved by VS Code: "switch terminal too" yields to it.
    if (this.terminalToo() && !this.terminalPin()) {
      let needsReload = false;
      if (scopeActive) {
        await this.writer.retire(vscodeSlot());
        await this.scope.deactivate();
        needsReload = true;
        notes.push("Claude Code in VS Code now follows the global login again. Reload every open VS Code window.");
      }
      notes.push(...(await this.writer.swapIn(globalSlot(), account)));
      return { needsReload, mustReload: needsReload, notes };
    }

    // VS Code only: the terminal's login is never touched. The VS Code slot, once set up,
    // stays on; switching it only rewrites its login, which running sessions pick up.
    const global = await this.index.owner(globalSlot());
    if (global.unresolved) {
      throw new UnresolvedLoginError();
    }
    if (global.accountId === account.id && !scopeActive) {
      return { needsReload: false, notes }; // VS Code already follows the terminal's login
    }
    if (global.accountId === account.id) {
      // VS Code takes the account the terminal uses: both keep it, AgentPool keeps the two
      // copies on one generation (see keepMirrored).
      await this.freshFrom(globalSlot(), account);
      notes.push(...(await this.writer.swapIn(vscodeSlot(), account)));
      notes.push("The terminal keeps it too; AgentPool keeps both in sync.");
      return { needsReload: false, notes };
    }
    this.scope.prepareFolder();
    notes.push(...(await this.writer.swapIn(vscodeSlot(), account)));
    if (!scopeActive) {
      await this.scope.activate();
      notes.push("One-time setup: Claude Code in VS Code now has its own login slot (the terminal keeps its account). Reload this window once — from now on switches need no reload.");
      return { needsReload: true, mustReload: true, notes };
    }
    return { needsReload: false, notes };
  }

  async login(cancel: { isCancellationRequested: boolean }) {
    const dir = path.join(poolHome(), `login-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const slot = slotForDir("login", dir);
    const command = findClaudeBinary(vscode.workspace.getConfiguration("agentPool").get<string>("claudeCommand"));
    if (!command) {
      throw new Error("Claude Code CLI not found. Install the Claude Code extension or CLI, or set agentPool.claudeCommand.");
    }
    const terminal = vscode.window.createTerminal({
      name: "AgentPool: Claude login",
      env: { CLAUDE_CONFIG_DIR: dir },
      ...cliTerminal(command, ["auth", "login"]),
    });
    terminal.show();
    try {
      const oauth = await waitFor(async () => (await readLive(slot)).doc?.claudeAiOauth, cancel, 10 * 60_000);
      const identity = await fetchClaudeIdentity(oauth.accessToken);
      return { secret: { kind: "claude" as const, oauth }, identity };
    } finally {
      terminal.dispose();
      // The login now lives only in the vault (parked); leave no copy behind.
      await clearLive(slot).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A usable access token for the account, wherever its login lives. */
  private async accessToken(account: AccountMeta): Promise<string> {
    if ((await this.sharedAccount()) === account.id) {
      const shared = await this.writer.keepMirrored([globalSlot(), vscodeSlot()], account.id);
      if (shared) {
        return shared.accessToken;
      }
    }
    const slots = this.scope.isActive() ? [vscodeSlot(), globalSlot()] : [globalSlot()];
    for (const slot of slots) {
      let owner = await this.index.owner(slot);
      if (owner.unresolved && owner.oauth && isExpiring(owner.oauth)) {
        await this.writer.renewUnidentified(slot);
        owner = await this.index.owner(slot);
      }
      if (owner.unresolved) {
        // It may be this very account, rotated by Claude Code: never fall back to a vault
        // copy whose refresh token could already be spent.
        throw new UnresolvedLoginError();
      }
      if (owner.accountId === account.id && owner.oauth) {
        return isExpiring(owner.oauth)
          ? (await this.writer.renewLive(slot, account.id)).accessToken
          : owner.oauth.accessToken;
      }
    }
    // Parked: AgentPool alone holds it; renewed under its cross-window lock.
    return (await this.writer.freshParked(account)).accessToken;
  }
}
