import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function codexHome(): string {
  const env = process.env.CODEX_HOME;
  return env && env.trim() ? env : path.join(os.homedir(), ".codex");
}

export function authFile(home = codexHome()): string {
  return path.join(home, "auth.json");
}

/**
 * The credential store Codex is configured with. Only `file` keeps the login in
 * auth.json; `keyring`/`auto` keep it in a Keychain item only `codex` may read.
 * Layers read, lowest first: /etc/codex/config.toml, $CODEX_HOME/config.toml,
 * /etc/codex/managed_config.toml.
 */
export function configuredStore(home = codexHome()): string {
  let store = "file";
  for (const file of ["/etc/codex/config.toml", path.join(home, "config.toml"), "/etc/codex/managed_config.toml"]) {
    const value = readTopLevelKey(file, "cli_auth_credentials_store");
    if (value) {
      store = value;
    }
  }
  return store;
}

/** Reads `key = "value"` before the first [table] of a TOML file. */
export function readTopLevelKey(file: string, key: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      break;
    }
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`));
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

/** The Codex CLI: the setting, `codex` on PATH, or the binary bundled with the extension. */
export function findCodexBinary(setting: string | undefined): string | undefined {
  if (setting) {
    return setting;
  }
  try {
    const found = execFileSync("/bin/sh", ["-lc", "command -v codex"], { timeout: 5_000 }).toString().trim();
    if (found) {
      return found;
    }
  } catch {
    /* not on PATH */
  }
  const extDir = path.join(os.homedir(), ".vscode", "extensions");
  let candidates: string[] = [];
  try {
    candidates = fs.readdirSync(extDir).filter((n) => n.startsWith("openai.chatgpt-")).sort().reverse();
  } catch {
    return undefined;
  }
  for (const ext of candidates) {
    const bin = path.join(extDir, ext, "bin");
    try {
      for (const platformDir of fs.readdirSync(bin)) {
        const exe = path.join(bin, platformDir, process.platform === "win32" ? "codex.exe" : "codex");
        if (fs.existsSync(exe)) {
          return exe;
        }
      }
    } catch {
      /* layout differs */
    }
  }
  return undefined;
}
