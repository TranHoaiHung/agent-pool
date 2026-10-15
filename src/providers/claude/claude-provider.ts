import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { poolHome } from "../../core/pool-store";
import { AccountMeta, UsageSnapshot } from "../../core/types";
import { HttpError } from "../http";
import { Place, Provider, ProviderContext, SwitchOutcome, waitFor } from "../provider";
import { fetchClaudeIdentity, fetchClaudeUsage, isExpiring } from "./claude-api";
import { clearLive, readLive } from "./claude-credential-store";
import { ClaudeLiveIndex, UnresolvedLoginError } from "./claude-live-index";
import { ClaudeSlot, globalSlot, slotForDir, vscodeSlot } from "./claude-paths";
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

  async switchTo(account: AccountMeta): Promise<SwitchOutcome> {
    const notes: string[] = [];
    let needsReload = false;
    const scopeActive = this.scope.isActive();

    if (this.terminalToo()) {
      if (scopeActive) {
        await this.writer.retire(vscodeSlot());
        await this.scope.deactivate();
        needsReload = true;
        notes.push("Claude Code in VS Code now follows the global login again. Reload every open VS Code window.");
      }
      notes.push(...(await this.writer.swapIn(globalSlot(), account)));
      return { needsReload, notes };
    }

    // VS Code only. Following the global slot is enough when it already holds the account:
    // one login must never be live in two slots (both would spend one refresh token).
    const global = await this.index.owner(globalSlot());
    if (global.unresolved) {
      throw new UnresolvedLoginError();
    }
    if (global.accountId === account.id) {
      if (scopeActive) {
        await this.writer.retire(vscodeSlot());
        await this.scope.deactivate();
        needsReload = true;
        notes.push("Reload every open VS Code window so all follow the terminal's login.");
      }
      return { needsReload, notes };
    }
    this.scope.prepareFolder();
    notes.push(...(await this.writer.swapIn(vscodeSlot(), account)));
    if (!scopeActive) {
      await this.scope.activate();
      needsReload = true;
      notes.push("Claude Code in VS Code now uses its own login slot; the terminal keeps its account.");
    }
    return { needsReload, notes };
  }

  async login(cancel: { isCancellationRequested: boolean }) {
    const dir = path.join(poolHome(), `login-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const slot = slotForDir("login", dir);
    const command = vscode.workspace.getConfiguration("agentPool").get<string>("claudeCommand") || "claude";
    const terminal = vscode.window.createTerminal({
      name: "AgentPool: Claude login",
      env: { CLAUDE_CONFIG_DIR: dir },
    });
    terminal.show();
    terminal.sendText(`${command} auth login`);
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
