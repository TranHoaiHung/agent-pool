import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { vscodeSlotDir } from "../providers/claude/claude-paths";
import { clearRequest, readRequest, writeRequest } from "./handoff-files";
import { hooksInstalled, installHooks, uninstallHooks, writeLauncher } from "./hook-installer";

const CONSENT_KEY = "agentPool.handoffConsent";

/**
 * Handoff between Claude accounts: installs AgentPool's two Claude Code hooks (with the
 * person's consent, once), and raises/clears the "write a handoff" request around switches.
 */
export class HandoffController {
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

  /** Called on every usage read of the Claude account in use. */
  onActiveUsage(label: string, usedPercent: number, thresholdPercent: number, hasNextAccount: boolean): void {
    if (!this.enabled() || !hasNextAccount || this.context.globalState.get<string>(CONSENT_KEY) !== "yes") {
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

  /** After a Claude switch: no more handoffs asked of sessions now on the new account. */
  onSwitched(): string | undefined {
    const pending = readRequest();
    clearRequest();
    return pending && this.enabled()
      ? "A handoff was asked of the previous session: start a new Claude conversation (or /clear) to continue from it cheaply."
      : undefined;
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
