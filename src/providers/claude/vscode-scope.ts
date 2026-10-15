import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { LinkKind, linkShared, refreshCopy } from "../../core/fs-utils";
import { vscodeSlotDir } from "./claude-paths";

const ENV_NAME = "CLAUDE_CONFIG_DIR";

/**
 * The VS Code-only scope: Claude Code inside VS Code runs with CLAUDE_CONFIG_DIR pointing
 * at AgentPool's slot, so switching it leaves the terminal's `claude` alone. The folder is
 * fixed, so the variable is set once; later switches only rewrite the slot's login.
 */
export class VscodeScope {
  constructor(private readonly log: (message: string) => void = () => undefined) {}

  /** Claude Code in VS Code currently uses AgentPool's own slot. */
  isActive(): boolean {
    return this.envEntries().some((e) => e.name === ENV_NAME && e.value === vscodeSlotDir());
  }

  /** Prepares the slot folder and points Claude Code in VS Code at it. */
  async activate(): Promise<void> {
    this.prepareFolder();
    const entries = this.envEntries().filter((e) => e.name !== ENV_NAME);
    entries.push({ name: ENV_NAME, value: vscodeSlotDir() });
    await this.claudeConfig().update("environmentVariables", entries, vscode.ConfigurationTarget.Global);
    await this.updateTerminalEnv(true);
  }

  /** Points Claude Code in VS Code back at the global login. */
  async deactivate(): Promise<void> {
    const entries = this.envEntries().filter(
      (e) => !(e.name === ENV_NAME && e.value === vscodeSlotDir())
    );
    await this.claudeConfig().update(
      "environmentVariables",
      entries.length ? entries : undefined,
      vscode.ConfigurationTarget.Global
    );
    await this.updateTerminalEnv(false);
  }

  /**
   * Links the shared items of ~/.claude into the slot (re-run on activation to pick up new
   * ones and refresh Windows copies). One item that cannot be linked never stops the rest.
   */
  prepareFolder(): void {
    const dir = vscodeSlotDir();
    const home = path.join(os.homedir(), ".claude");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ledgerFile = path.join(dir, ".agent-pool-links.json");
    const ledger = readLedger(ledgerFile);
    const items = vscode.workspace.getConfiguration("agentPool").get<string[]>("claude.sharedItems") ?? [];
    for (const item of items) {
      const source = path.join(home, item);
      const link = path.join(dir, item);
      try {
        if (!fs.existsSync(source) || isSymlink(link)) {
          continue;
        }
        if (fs.existsSync(link)) {
          // A copy or hard link AgentPool made (Windows) follows the source; any other real
          // file belongs to the slot and is never overwritten.
          if (ledger[item] === "copy" || ledger[item] === "hardlink") {
            refreshCopy(source, link);
          }
          continue;
        }
        ledger[item] = linkShared(source, link);
      } catch (e) {
        this.log(`Could not share ~/.claude/${item} with the VS Code slot: ${(e as Error).message}`);
      }
    }
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
    // Seed Claude Code's config (MCP servers, onboarding state) once; it diverges after.
    const config = path.join(dir, ".claude.json");
    const globalConfig = path.join(os.homedir(), ".claude.json");
    if (!fs.existsSync(config) && fs.existsSync(globalConfig)) {
      fs.copyFileSync(globalConfig, config);
      fs.chmodSync(config, 0o600);
    }
  }


  /** Items in ~/.claude that the slot does not link (shown as a hint). */
  unlinkedItems(): string[] {
    const home = path.join(os.homedir(), ".claude");
    const items = new Set(vscode.workspace.getConfiguration("agentPool").get<string[]>("claude.sharedItems") ?? []);
    const ignore = new Set([".credentials.json", "backups", "cache", "debug", "statsig", "telemetry", "shell-snapshots", "session-env", "paste-cache", "file-history", "ide", "downloads"]);
    try {
      return fs.readdirSync(home).filter((n) => !items.has(n) && !ignore.has(n) && !n.startsWith("."));
    } catch {
      return [];
    }
  }

  private async updateTerminalEnv(on: boolean): Promise<void> {
    const wanted = vscode.workspace.getConfiguration("agentPool").get<boolean>("claude.applyToIntegratedTerminal");
    const key = process.platform === "darwin" ? "osx" : process.platform === "win32" ? "windows" : "linux";
    const terminal = vscode.workspace.getConfiguration("terminal.integrated.env");
    const env = { ...(terminal.get<Record<string, string | null>>(key) ?? {}) };
    if (on && wanted) {
      env[ENV_NAME] = vscodeSlotDir();
    } else if (env[ENV_NAME] === vscodeSlotDir()) {
      delete env[ENV_NAME];
    } else {
      return;
    }
    await terminal.update(key, Object.keys(env).length ? env : undefined, vscode.ConfigurationTarget.Global);
  }

  private claudeConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("claudeCode");
  }

  private envEntries(): Array<{ name: string; value: string }> {
    const value = this.claudeConfig().get<Array<{ name: string; value: string }>>("environmentVariables");
    return Array.isArray(value) ? value.filter((e) => e && typeof e.name === "string") : [];
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function readLedger(file: string): Record<string, LinkKind> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, LinkKind>;
  } catch {
    return {};
  }
}
