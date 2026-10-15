import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** A command found on the login shell's PATH (VS Code started from the Dock has a short PATH). */
export function onPath(name: string): string | undefined {
  try {
    const found = execFileSync("/bin/sh", ["-lc", `command -v ${name}`], { timeout: 5_000 }).toString().trim();
    return found || undefined;
  } catch {
    return undefined;
  }
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
