import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { groupSlotName } from "../../core/groups";
import { poolHome } from "../../core/pool-store";
import { extensionDirs, onPath } from "../cli-locator";

export const LIVE_SERVICE = "Claude Code-credentials";
export const CRED_FILE = ".credentials.json";

/**
 * A place Claude Code keeps one login: its storage directory and, on macOS, the Keychain
 * service derived from it. The global slot is what Claude Code uses with no
 * CLAUDE_CONFIG_DIR; the VS Code slot is AgentPool's own CLAUDE_CONFIG_DIR.
 */
export interface ClaudeSlot {
  name: "global" | "vscode" | "login";
  /** Storage directory: `~/.claude`, or the CLAUDE_CONFIG_DIR value. */
  dir: string;
  service: string;
  /** Claude Code's config file (`oauthAccount` lives here). */
  configFile: string;
}

/** Claude Code reads `$USER || os.userInfo().username`, restricted to `[a-zA-Z0-9._-]`. */
export function keychainAccount(): string {
  const candidates = [process.env.USER, safeUsername()];
  for (const name of candidates) {
    if (name && /^[a-zA-Z0-9._-]+$/.test(name)) {
      return name;
    }
  }
  return "claude-code-user";
}

/** First 8 hex chars of SHA-256 over the NFC path string, hashed verbatim. */
export function dirHash(dir: string): string {
  return crypto.createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
}

export function serviceForDir(dir: string): string {
  return `${LIVE_SERVICE}-${dirHash(dir)}`;
}

let launchDir: { value: string | undefined } | undefined;

/** The CLAUDE_CONFIG_DIR VS Code was started with (AgentPool may set its own for this window). */
export function launchConfigDir(): string | undefined {
  return launchDir ? launchDir.value : process.env.CLAUDE_CONFIG_DIR;
}

/**
 * Sets CLAUDE_CONFIG_DIR for this window's extension host, which Claude Code passes on to the
 * sessions it starts (account groups: one slot per window). Undefined restores the original.
 */
export function setWindowConfigDir(dir: string | undefined): void {
  launchDir ??= { value: process.env.CLAUDE_CONFIG_DIR };
  const value = dir ?? launchDir.value;
  if (value === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = value;
  }
}

export function globalSlot(): ClaudeSlot {
  const configDir = launchConfigDir();
  if (configDir && path.isAbsolute(configDir)) {
    // VS Code itself was started with CLAUDE_CONFIG_DIR: that is the "global" login here.
    return { name: "global", dir: configDir, service: serviceForDir(configDir), configFile: path.join(configDir, ".claude.json") };
  }
  return {
    name: "global",
    dir: path.join(os.homedir(), ".claude"),
    service: LIVE_SERVICE,
    configFile: path.join(os.homedir(), ".claude.json"),
  };
}

export function vscodeSlotDir(): string {
  return path.join(poolHome(), "claude-vscode");
}

/** A group's VS Code slot folder (the default group's is the original VS Code slot). */
export function groupSlotDir(group: string): string {
  return path.join(poolHome(), groupSlotName(group));
}

export function vscodeSlot(): ClaudeSlot {
  return slotForDir("vscode", vscodeSlotDir());
}

export function slotForDir(name: ClaudeSlot["name"], dir: string): ClaudeSlot {
  return { name, dir, service: serviceForDir(dir), configFile: path.join(dir, ".claude.json") };
}

function safeUsername(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * The Claude Code CLI: the setting, else the native binary the Claude Code extension ships
 * with (self-contained: no Node or PATH needed), else `claude` on PATH.
 */
export function findClaudeBinary(setting: string | undefined): string | undefined {
  if (setting) {
    return setting;
  }
  for (const ext of extensionDirs("anthropic.claude-code-")) {
    const exe = path.join(ext, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude");
    if (fs.existsSync(exe)) {
      return exe;
    }
  }
  return onPath("claude");
}
