import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { LinkKind, linkShared, refreshCopy } from "../../core/fs-utils";
import { setWindowConfigDir, vscodeSlotDir } from "./claude-paths";
import { linkProjectHistory } from "./project-history";
import { WindowGroup } from "./window-group";

const ENV_NAME = "CLAUDE_CONFIG_DIR";
/** Settings an isolated group's config starts with: onboarding state only, no MCP servers or history. */
const ISOLATED_CONFIG_KEYS = ["hasCompletedOnboarding", "lastOnboardingVersion", "theme", "installMethod", "autoUpdates"];

/**
 * The VS Code-only scope: Claude Code inside VS Code runs with CLAUDE_CONFIG_DIR pointing
 * at AgentPool's slot, so switching it leaves the terminal's `claude` alone. The folder is
 * fixed, so the variable is set once; later switches only rewrite the slot's login.
 *
 * Without account groups the variable comes from the (machine-wide) claudeCode setting. With
 * groups every window sets it in its own extension host instead, which Claude Code passes on
 * to its sessions, so windows of different groups run different accounts side by side.
 */
export class VscodeScope {
  /** Whether this window currently applies its group's slot through its own environment. */
  private applied = false;

  constructor(
    private readonly log: (message: string) => void = () => undefined,
    readonly win?: WindowGroup,
    private readonly terminalEnv?: vscode.EnvironmentVariableCollection
  ) {}

  /** Claude Code in VS Code currently uses an AgentPool slot. */
  isActive(): boolean {
    return this.groups() || this.settingActive();
  }

  /** The slot folder Claude Code in this window uses. */
  slotDir(): string {
    return this.groups() ? this.win!.dir() : vscodeSlotDir();
  }

  /** The login folder Claude Code in this window reads (undefined: the global one). */
  effectiveDir(): string | undefined {
    return this.isActive() ? this.slotDir() : undefined;
  }

  /**
   * Puts this window's environment in line with the groups setup: sets CLAUDE_CONFIG_DIR
   * for Claude Code started from here, drops the machine-wide setting (it would override
   * every window's own value), and gives integrated terminals of a group's window its slot.
   * Called first thing on activation and whenever the pool changes.
   */
  async apply(): Promise<void> {
    if (this.groups()) {
      setWindowConfigDir(this.win!.dir());
      const firstTime = !this.applied;
      this.applied = true;
      this.applyTerminal();
      if (firstTime) {
        this.prepareFolder();
        const foreign = this.envEntries().find((e) => e.name === ENV_NAME && e.value !== vscodeSlotDir());
        if (foreign) {
          // Claude Code applies the setting over the window's own environment: groups cannot work.
          void vscode.window.showWarningMessage(
            `AgentPool: claudeCode.environmentVariables sets CLAUDE_CONFIG_DIR=${foreign.value}, which overrides account groups in every window. Remove that entry to use groups.`
          );
        }
        if (this.settingActive()) {
          await this.removeSetting();
          this.log("Account groups on: each window now sets CLAUDE_CONFIG_DIR itself.");
        }
      }
    } else if (this.applied) {
      // Groups removed: back to the machine-wide setting.
      this.applied = false;
      setWindowConfigDir(undefined);
      this.terminalEnv?.delete(ENV_NAME);
      await this.activate();
    }
  }

  /** Prepares the slot folder and points Claude Code in VS Code at it. */
  async activate(): Promise<void> {
    this.prepareFolder();
    if (this.groups()) {
      return; // the window's own environment points at it
    }
    const entries = this.envEntries().filter((e) => e.name !== ENV_NAME);
    entries.push({ name: ENV_NAME, value: vscodeSlotDir() });
    await this.claudeConfig().update("environmentVariables", entries, vscode.ConfigurationTarget.Global);
    await this.updateTerminalEnv(true);
  }

  /** Points Claude Code in VS Code back at the global login. */
  async deactivate(): Promise<void> {
    await this.removeSetting();
  }

  /**
   * Links the shared items of ~/.claude into the slot (re-run on activation to pick up new
   * ones and refresh Windows copies). One item that cannot be linked never stops the rest.
   * A group other than the default one is isolated: it links only `claude.groupSharedItems`
   * and its config does not copy MCP servers or project history.
   */
  prepareFolder(): void {
    const dir = this.slotDir();
    const isolated = this.groups() && !this.win!.isDefault();
    const home = path.join(os.homedir(), ".claude");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ledgerFile = path.join(dir, ".agent-pool-links.json");
    const ledger = readLedger(ledgerFile);
    const cfg = vscode.workspace.getConfiguration("agentPool");
    const items = (isolated ? cfg.get<string[]>("claude.groupSharedItems") : cfg.get<string[]>("claude.sharedItems")) ?? [];
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
    if (isolated) {
      // The workspace's own conversations (and only those), so they can be continued here.
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
      linkProjectHistory(path.join(home, "projects"), dir, folders, this.log);
    }
    // Seed Claude Code's config (MCP servers, onboarding state) once; it diverges after.
    const config = path.join(dir, ".claude.json");
    const globalConfig = path.join(os.homedir(), ".claude.json");
    if (!fs.existsSync(config) && fs.existsSync(globalConfig)) {
      if (isolated) {
        fs.writeFileSync(config, JSON.stringify(pick(globalConfig, ISOLATED_CONFIG_KEYS), null, 2), { mode: 0o600 });
      } else {
        fs.copyFileSync(globalConfig, config);
      }
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

  private groups(): boolean {
    return this.win?.on() ?? false;
  }

  private settingActive(): boolean {
    return this.envEntries().some((e) => e.name === ENV_NAME && e.value === vscodeSlotDir());
  }

  /** `claude` in this window's integrated terminals: a group's slot, or the default slot when asked. */
  private applyTerminal(): void {
    const wanted = !this.win!.isDefault() || vscode.workspace.getConfiguration("agentPool").get<boolean>("claude.applyToIntegratedTerminal");
    // Only on a change: every write marks open terminals as needing a relaunch.
    const current = this.terminalEnv?.get(ENV_NAME)?.value;
    if (wanted && current !== this.win!.dir()) {
      this.terminalEnv?.replace(ENV_NAME, this.win!.dir());
    } else if (!wanted && current !== undefined) {
      this.terminalEnv?.delete(ENV_NAME);
    }
  }

  private async removeSetting(): Promise<void> {
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

function pick(file: string, keys: string[]): Record<string, unknown> {
  try {
    const all = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(keys.filter((k) => all[k] !== undefined).map((k) => [k, all[k]]));
  } catch {
    return {};
  }
}
