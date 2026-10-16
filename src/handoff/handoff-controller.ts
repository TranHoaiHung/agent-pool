import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { vscodeSlotDir } from "../providers/claude/claude-paths";
import { clearRequest, handoffCapturedSince, readRequest, writeRequest } from "./handoff-files";
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
        writeRequest(label);
        this.log(`handoff requested: ${label} at ${usedPercent}%`);
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
    if (!this.active() || !request || handoffCapturedSince(request.at) || usedPercent >= HOLD_LIMIT_PERCENT) {
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
    clearRequest();
    this.holdingSince = undefined;
    if (!pending || !this.active()) {
      return undefined;
    }
    const handoff = handoffCapturedSince(pending.at);
    return {
      handoff,
      note: handoff
        ? "Switched to another organization. A handoff of your work is ready: continue in a new Claude conversation so it starts from it instead of rereading the whole old one."
        : "Switched to another organization before a handoff was written: a new conversation starts cheaper, the old one has to reread its history.",
    };
  }

  /** "ask" (default), "auto" or "off": opening a new Claude conversation after such a switch. */
  newConversationMode(): string {
    return vscode.workspace.getConfiguration("agentPool").get<string>("claude.handoff.newConversation") ?? "ask";
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
    const global = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
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
