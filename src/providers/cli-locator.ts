import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A command found on PATH: the login shell's on macOS/Linux (VS Code started from the Dock
 * has a short PATH), `where.exe` on Windows (first match; npm installs a `.cmd` there).
 */
export function onPath(name: string): string | undefined {
  try {
    const found =
      process.platform === "win32"
        ? execFileSync("where.exe", [name], { timeout: 5_000 }).toString().split(/\r?\n/)[0]
        : execFileSync("/bin/sh", ["-lc", `command -v ${name}`], { timeout: 5_000 }).toString();
    return found.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Terminal options that run `binary args` directly, with no shell in between, so nothing
 * depends on quoting rules (bash, zsh, PowerShell and cmd all differ). Windows batch files
 * (`claude.cmd` from npm) need cmd.exe to run.
 */
export function cliTerminal(binary: string, args: string[]): { shellPath: string; shellArgs: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    return { shellPath: process.env.ComSpec || "cmd.exe", shellArgs: ["/d", "/c", binary, ...args] };
  }
  return { shellPath: binary, shellArgs: args };
}

/** Installed extension folders starting with `prefix`, newest version first. */
export function extensionDirs(prefix: string): string[] {
  const root = path.join(os.homedir(), ".vscode", "extensions");
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((n) => n.startsWith(prefix));
  } catch {
    return [];
  }
  const version = (n: string) => (n.slice(prefix.length).match(/\d+/g) ?? []).map(Number);
  return names
    .sort((a, b) => {
      const va = version(a);
      const vb = version(b);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (vb[i] ?? 0) - (va[i] ?? 0);
        if (d !== 0) return d;
      }
      return 0;
    })
    .map((n) => path.join(root, n));
}
