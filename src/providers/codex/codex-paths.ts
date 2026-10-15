import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extensionDirs, onPath } from "../cli-locator";

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

/**
 * The Codex CLI: the setting, else the native binary bundled with the ChatGPT/Codex
 * extension (no PATH needed), else `codex` on PATH.
 */
export function findCodexBinary(setting: string | undefined): string | undefined {
  if (setting) {
    return setting;
  }
  for (const ext of extensionDirs("openai.chatgpt-")) {
    const bin = path.join(ext, "bin");
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
  return onPath("codex");
}
