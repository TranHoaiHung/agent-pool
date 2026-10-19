import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { launchConfigDir, vscodeSlotDir } from "../providers/claude/claude-paths";
import {
  clearCompacted,
  clearRequest,
  compactedSince,
  handoffCapturedSince,
  handoffDir,
  HandoffMode,
  readRequest,
  writeRequest,
} from "./handoff-files";
import { hooksInstalled, installHooks, uninstallHooks, writeLauncher } from "./hook-installer";

const CONSENT_KEY = "agentPool.handoffConsent";
/** The switch waits for a handoff at most this long after reaching the threshold, and never past 99%. */
const MAX_HOLD_MS = 5 * 60_000;
const HOLD_LIMIT_PERCENT = 99;

/**
 * Handoff between Claude accounts: installs AgentPool's two Claude Code hooks (with the
 * person's consent, once), and raises/clears the "write a handoff" request around switches.
 */
export class HandoffController {
  private holdingSince?: number;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void
  ) {}

  enabled(): boolean {
    return vscode.workspace.getConfiguration("agentPool").get<boolean>("claude.handoff.enabled", true);
  }

  mode(): HandoffMode {
    const m = vscode.workspace.getConfiguration("agentPool").get<string>("claude.handoff.mode");
    return m === "newConversation" ? "newConversation" : "compact";
  }

  /**
   * Compact mode: calls `onCompacted` when a conversation was compacted while a switch is due,
   * so AgentPool switches right away (before more replies add thinking from the old account).
   */
  watchCompaction(onCompacted: () => void): vscode.Disposable {
    fs.mkdirSync(handoffDir(), { recursive: true });
    let timer: NodeJS.Timeout | undefined;
    const watcher = fs.watch(handoffDir(), (_e, name) => {
      if (name !== "compacted.json") {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        const request = readRequest();
        if (request && compactedSince(request.at)) {
          onCompacted();
        }
      }, 500);
    });
    return { dispose: () => watcher.close() };
  }

  marginPercent(): number {
    return Math.max(1, vscode.workspace.getConfiguration("agentPool").get<number>("claude.handoff.marginPercent") ?? 5);
  }

  /** Brings the hooks in line with the setting; asks before the first install. */
  async sync(): Promise<void> {
    try {
      if (!this.enabled()) {
        this.settingsFiles().forEach((f) => hooksInstalled(f) && uninstallHooks(f));
        return;
      }
      const launcher = writeLauncher(path.join(this.context.extensionPath, "dist", "handoff-hook.js"), process.execPath);
      const files = this.settingsFiles();
      const fresh = !files.every(hooksInstalled);
      if (fresh && !(await this.consent())) {
        return;
      }
      files.forEach((f) => installHooks(f, launcher)); // also refreshes the launcher path
      if (fresh) {
        this.log(`handoff hooks installed in ${files.join(", ")}`);
      }
    } catch (e) {
      this.log(`handoff hooks: ${(e as Error).message}`);
    }
  }

  private active(): boolean {
    return this.enabled() && this.context.globalState.get<string>(CONSENT_KEY) === "yes";
  }

  /**
   * Called on every usage read of the Claude account in use. A handoff is asked only when the
   * next account is in another organization: within one, the session keeps its thinking.
   */
  onActiveUsage(label: string, usedPercent: number, thresholdPercent: number, next: { exists: boolean; crossOrg: boolean }): void {
    if (!this.active() || !next.exists || !next.crossOrg) {
      return;
    }
    if (usedPercent >= thresholdPercent - this.marginPercent()) {
      if (!readRequest()) {
        writeRequest(label, this.mode());
        this.log(`handoff requested (${this.mode()}): ${label} at ${usedPercent}%`);
        if (this.mode() === "compact") {
          void this.promptCompact(label, usedPercent);
        }
      }
    } else if (readRequest()?.from === label) {
      clearRequest(); // the account recovered (its window reset) before switching
    }
  }

  /**
   * A threshold switch waits for the handoff (Claude writes it when it next finishes a reply),
   * for at most five minutes and never past 99%, so a long turn does not lose it.
   */
  shouldHoldSwitch(usedPercent: number): boolean {
    const request = readRequest();
    // Compact mode never waits: without a compaction by the threshold, the switch goes ahead.
    if (!this.active() || !request || request.mode === "compact" || handoffCapturedSince(request.at) || usedPercent >= HOLD_LIMIT_PERCENT) {
      this.holdingSince = undefined;
      return false;
    }
    this.holdingSince ??= Date.now();
    if (Date.now() - this.holdingSince > MAX_HOLD_MS) {
      this.holdingSince = undefined;
      return false;
    }
    return true;
  }

  /** After a Claude switch: what to tell the person, and whether a new conversation should start. */
  onSwitched(): { note: string; handoff: boolean } | undefined {
    const pending = readRequest();
    const compacted = pending ? compactedSince(pending.at) : false;
    clearRequest();
    clearCompacted();
    this.holdingSince = undefined;
    if (!pending || !this.active()) {
      return undefined;
    }
    if (pending.mode === "compact") {
      return {
        handoff: false,
        note: compacted
          ? "Switched right after the compaction: keep going in the same conversation — it continues from its summary."
          : "Switched without a compaction: the same conversation continues, but its first reply rereads the history (slower, more tokens).",
      };
    }
    const handoff = handoffCapturedSince(pending.at);
    return {
      handoff,
      note: handoff
        ? "Switched to another organization. A handoff of your work is ready: continue in a new Claude conversation so it starts from it instead of rereading the whole old one."
        : "Switched to another organization before a handoff was written: a new conversation starts cheaper, the old one has to reread its history.",
    };
  }

  /** Compact mode at the margin: one click copies /compact and focuses Claude's input. */
  private async promptCompact(label: string, usedPercent: number): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `AgentPool: Claude "${label}" is at ${usedPercent}%. Run /compact in Claude now — AgentPool switches accounts right after and the same conversation continues from its summary. Without it, the switch happens at the threshold anyway.`,
      "Compact now"
    );
    if (choice === "Compact now") {
      await vscode.env.clipboard.writeText("/compact");
      await vscode.commands.executeCommand("claude-vscode.focus").then(undefined, () => undefined);
      void vscode.window.showInformationMessage("AgentPool: /compact copied — paste it in Claude's input and press Enter.");
    }
  }

  /** "off" (default), "ask" or "auto": opening a new Claude conversation after such a switch. */
  newConversationMode(): string {
    return vscode.workspace.getConfiguration("agentPool").get<string>("claude.handoff.newConversation") ?? "off";
  }

  private async consent(): Promise<boolean> {
    const saved = this.context.globalState.get<string>(CONSENT_KEY);
    if (saved) {
      return saved === "yes";
    }
    const choice = await vscode.window.showInformationMessage(
      "AgentPool handoff: before switching Claude accounts, Claude writes a short summary of the work in progress, and the next conversation on the new account starts from it. This adds two hooks (Stop, SessionStart) to ~/.claude/settings.json; your other hooks stay untouched.",
      { modal: true },
      "Enable",
      "Not now"
    );
    const answer = choice === "Enable" ? "yes" : "no";
    await this.context.globalState.update(CONSENT_KEY, answer);
    if (answer === "no") {
      await vscode.workspace.getConfiguration("agentPool").update("claude.handoff.enabled", false, vscode.ConfigurationTarget.Global);
    }
    return answer === "yes";
  }

  /** ~/.claude/settings.json, plus the VS Code slot's own copy when it is not a link to it. */
  private settingsFiles(): string[] {
    const global = path.join(launchConfigDir() || path.join(os.homedir(), ".claude"), "settings.json");
    const slot = path.join(vscodeSlotDir(), "settings.json");
    const files = [global];
    try {
      if (fs.existsSync(slot) && fs.realpathSync(slot) !== fs.realpathSync(global) && fs.statSync(slot).ino !== fs.statSync(global).ino) {
        files.push(slot);
      }
    } catch {
      /* no slot yet */
    }
    return files;
  }
}
