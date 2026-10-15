import * as fs from "fs";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Moves `tmp` over `dest`. On Windows a rename fails while another process (Claude Code,
 * an antivirus scan) has the target open, so it is retried briefly before giving up.
 */
export function replaceFile(tmp: string, dest: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !RETRYABLE.has(code) || attempt >= 10) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(50 * (attempt + 1));
    }
  }
}

export type LinkKind = "symlink" | "junction" | "hardlink" | "copy";

/**
 * Makes `link` show `source`. Symlinks need admin rights or Developer Mode on Windows, so
 * there folders become junctions (no rights needed) and files fall back to a hard link
 * (same drive) or, last, a copy that `refreshCopy` keeps current.
 */
export function linkShared(source: string, link: string): LinkKind {
  const isDir = fs.statSync(source).isDirectory();
  if (process.platform !== "win32") {
    fs.symlinkSync(source, link);
    return "symlink";
  }
  if (isDir) {
    fs.symlinkSync(source, link, "junction");
    return "junction";
  }
  try {
    fs.symlinkSync(source, link, "file");
    return "symlink";
  } catch {
    /* no symlink rights: try the next kind */
  }
  try {
    fs.linkSync(source, link);
    return "hardlink";
  } catch {
    fs.copyFileSync(source, link);
    return "copy";
  }
}

/** Copies `source` over a copied `link` when the source changed since. */
export function refreshCopy(source: string, link: string): void {
  if (fs.statSync(source).mtimeMs > fs.statSync(link).mtimeMs) {
    fs.copyFileSync(source, link);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
