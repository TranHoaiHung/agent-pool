import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { HANDOFF_MARKER, handoffFile, onStop, readRequest, takeHandoff, writeRequest } from "../src/handoff/handoff-files";
import { hooksInstalled, installHooks, uninstallHooks, writeLauncher } from "../src/handoff/hook-installer";

let home: string;
const project = path.join(os.tmpdir(), "my-project");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pool-home-"));
  process.env.AGENT_POOL_HOME = home;
});

describe("handoff flow", () => {
  it("does nothing until a switch is near", () => {
    expect(onStop(project, false, "done")).toBeUndefined();
  });

  it("asks once for a handoff reply, saves it, then lets Claude stop", () => {
    writeRequest("work");
    const reason = onStop(project, false, "finished the refactor");
    expect(reason).toContain(HANDOFF_MARKER);
    expect(reason).toContain('"work"');
    // Claude replies with the handoff; the next Stop (stop_hook_active) saves it.
    expect(onStop(project, true, `${HANDOFF_MARKER}\n## Goal\nShip 0.1.6`)).toBeUndefined();
    expect(fs.readFileSync(handoffFile(project), "utf8")).toContain("Ship 0.1.6");
    // Saved and newer than the request: later turns are not interrupted again.
    expect(onStop(project, false, "more work")).toBeUndefined();
  });

  it("never blocks twice in a row (stop_hook_active)", () => {
    writeRequest("work");
    expect(onStop(project, true, "no marker")).toBeUndefined();
  });

  it("feeds the handoff to the next session once, then archives it", () => {
    writeRequest("work");
    onStop(project, true, `${HANDOFF_MARKER}\nnext: run npm test`);
    const context = takeHandoff(project);
    expect(context).toContain("next: run npm test");
    expect(context).toContain("AgentPool handoff");
    expect(takeHandoff(project)).toBeUndefined();
    expect(fs.readdirSync(path.join(home, "handoff", "archive")).length).toBe(1);
  });

  it("ignores a request older than two hours", () => {
    writeRequest("work");
    expect(readRequest(Date.now() + 3 * 3_600_000)).toBeUndefined();
  });
});

describe("hook installer", () => {
  const other = { matcher: "", hooks: [{ type: "command", command: "node other-hook.js" }] };

  it("adds Stop/SessionStart hooks next to existing ones and removes only its own", () => {
    const file = path.join(home, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ model: "x", hooks: { Stop: [other], PreCompact: [other] } }));
    const launcher = path.join(home, "hooks", "agent-pool-handoff.sh");
    installHooks(file, launcher);
    installHooks(file, launcher); // idempotent
    let s = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(s.model).toBe("x");
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(hooksInstalled(file)).toBe(true);
    uninstallHooks(file);
    s = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(s.hooks).toEqual({ Stop: [other], PreCompact: [other] });
  });

  it("refuses to rewrite a settings file it cannot parse", () => {
    const file = path.join(home, "settings.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => installHooks(file, "/x/hooks/agent-pool-handoff.sh")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("writes through a symlinked settings.json", () => {
    if (process.platform === "win32") return;
    const real = path.join(home, "real.json");
    const link = path.join(home, "link.json");
    fs.writeFileSync(real, "{}");
    fs.symlinkSync(real, link);
    installHooks(link, path.join(home, "hooks", "agent-pool-handoff.sh"));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(hooksInstalled(real)).toBe(true);
  });
});

describe("built hook script", () => {
  it("runs end to end through the launcher with Claude Code's JSON on stdin", () => {
    const built = path.join(__dirname, "..", "dist", "handoff-hook.js");
    if (!fs.existsSync(built) || process.platform === "win32") return;
    const launcher = writeLauncher(built, process.execPath);
    const env = { ...process.env, AGENT_POOL_HOME: home, CLAUDE_PROJECT_DIR: project };
    const run = (mode: string, input: object) =>
      execFileSync(launcher, [mode], { input: JSON.stringify(input), env }).toString();
    writeRequest("work");
    const blocked = JSON.parse(run("stop", { stop_hook_active: false, last_assistant_message: "ok" }));
    expect(blocked.decision).toBe("block");
    expect(run("stop", { stop_hook_active: true, last_assistant_message: `${HANDOFF_MARKER}\nstep 3 next` })).toBe("");
    expect(run("session-start", { source: "startup" })).toContain("step 3 next");
    expect(run("session-start", { source: "startup" })).toBe("");
  });
});
