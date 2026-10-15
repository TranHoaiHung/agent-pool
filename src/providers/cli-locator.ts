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
    if (process.platform === "win32") {
      // npm puts `claude` (a sh script), `claude.cmd` and `claude.ps1` side by side; only an
      // .exe or a batch file can be launched.
      const lines = execFileSync("where.exe", [name], { timeout: 5_000 }).toString().split(/\r?\n/);
      return lines.map((l) => l.trim()).find((l) => /\.(exe|cmd|bat)$/i.test(l));
    }
    const found = execFileSync("/bin/sh", ["-lc", `command -v ${name}`], { timeout: 5_000 }).toString();
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
  if (process.platform === "win32") {
    return /\.(cmd|bat)$/i.test(binary)
      ? { shellPath: process.env.ComSpec || "cmd.exe", shellArgs: ["/d", "/c", binary, ...args] }
      : { shellPath: binary, shellArgs: args };
  }
  if (isScript(binary)) {
    // A script (`#!/usr/bin/env node`, npm's claude) needs the person's PATH, which VS Code
    // started from the Dock lacks: run it from a login shell; "$0" "$@" keep it unquoted.
    return { shellPath: loginShell(), shellArgs: ["-ilc", 'exec "$0" "$@"', binary, ...args] };
  }
  return { shellPath: binary, shellArgs: args };
}

function isScript(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    return head.toString() === "#!";
  } catch {
    return false;
  }
}

/** The person's shell when it understands `-ilc` and "$@"; zsh/bash otherwise. */
function loginShell(): string {
  const shell = process.env.SHELL ?? "";
  if (/\/(zsh|bash|sh)$/.test(shell) && fs.existsSync(shell)) {
    return shell;
  }
  return fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
}

/**
 * Folders where the running editor keeps extensions: the one AgentPool itself was installed
 * in (VS Code, Insiders, Cursor, Windsurf, VSCodium, a remote server all differ), then the
 * well-known ones.
 */
export function extensionRoots(): string[] {
  const own = path.resolve(__dirname, "..", ".."); // <root>/<publisher.agent-pool-x.y.z>/dist
  const home = os.homedir();
  const known = [".vscode", ".vscode-insiders", ".cursor", ".windsurf", ".vscode-oss", ".vscode-server", ".cursor-server"]
    .map((d) => path.join(home, d, "extensions"));
  return [...new Set([own, ...known])].filter((d) => fs.existsSync(d));
}

/** Installed extension folders starting with `prefix`, newest version first, across roots. */
export function extensionDirs(prefix: string): string[] {
  const found: string[] = [];
  for (const root of extensionRoots()) {
    try {
      found.push(...fs.readdirSync(root).filter((n) => n.startsWith(prefix)).map((n) => path.join(root, n)));
    } catch {
      /* unreadable root */
    }
  }
  const version = (dir: string) => (path.basename(dir).slice(prefix.length).match(/\d+/g) ?? []).map(Number);
  return found.sort((a, b) => {
    const va = version(a);
    const vb = version(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
}
