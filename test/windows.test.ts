import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { linkShared, refreshCopy, replaceFile } from "../src/core/fs-utils";
import { cliTerminal } from "../src/providers/cli-locator";

const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p });
afterEach(() => setPlatform(realPlatform));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-"));

describe("cliTerminal", () => {
  it("runs a binary directly, with no shell quoting involved", () => {
    expect(cliTerminal("/Users/x/My Tools/claude", ["auth", "login"])).toEqual({
      shellPath: "/Users/x/My Tools/claude",
      shellArgs: ["auth", "login"],
    });
  });

  it("runs Windows batch files (npm's claude.cmd) through cmd.exe", () => {
    setPlatform("win32");
    const t = cliTerminal("C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd", ["auth", "login"]);
    expect(t.shellArgs).toEqual(["/d", "/c", "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd", "auth", "login"]);
    expect(t.shellPath.toLowerCase()).toContain("cmd");
  });
});

describe("linkShared", () => {
  it("symlinks on macOS/Linux", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "a.md"), "x");
    expect(linkShared(path.join(d, "a.md"), path.join(d, "b.md"))).toBe("symlink");
    expect(fs.lstatSync(path.join(d, "b.md")).isSymbolicLink()).toBe(true);
  });

  it("on Windows, files fall back to a link or copy instead of failing", () => {
    setPlatform("win32");
    const d = tmp();
    fs.writeFileSync(path.join(d, "CLAUDE.md"), "rules");
    const kind = linkShared(path.join(d, "CLAUDE.md"), path.join(d, "slot-CLAUDE.md"));
    expect(["symlink", "hardlink", "copy"]).toContain(kind);
    expect(fs.readFileSync(path.join(d, "slot-CLAUDE.md"), "utf8")).toBe("rules");
  });

  it("refreshes a copy when the source changes", () => {
    const d = tmp();
    const src = path.join(d, "s.json");
    const dst = path.join(d, "d.json");
    fs.writeFileSync(src, "1");
    fs.copyFileSync(src, dst);
    fs.utimesSync(dst, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    fs.writeFileSync(src, "2");
    refreshCopy(src, dst);
    expect(fs.readFileSync(dst, "utf8")).toBe("2");
  });
});

describe("replaceFile", () => {
  it("moves the temp file over the target", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "t"), "new");
    fs.writeFileSync(path.join(d, "f"), "old");
    replaceFile(path.join(d, "t"), path.join(d, "f"));
    expect(fs.readFileSync(path.join(d, "f"), "utf8")).toBe("new");
    expect(fs.existsSync(path.join(d, "t"))).toBe(false);
  });
});

describe("cliTerminal on macOS/Linux", () => {
  it("runs a #! script (npm's claude) from a login shell so node is on PATH", () => {
    if (process.platform === "win32") return;
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ap-sh-"));
    const script = path.join(d, "claude");
    fs.writeFileSync(script, "#!/usr/bin/env node\n", { mode: 0o755 });
    const t = cliTerminal(script, ["auth", "login"]);
    expect(t.shellArgs).toEqual(["-ilc", 'exec "$0" "$@"', script, "auth", "login"]);
    expect(t.shellPath).toMatch(/\/(zsh|bash|sh)$/);
  });
});
