import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { compactedSince, compactReminder, markCompacted, HANDOFF_MARKER, handoffCapturedSince, handoffFile, onStop, readRequest, takeHandoff, writeRequest } from "../src/handoff/handoff-files";
import { factsMarkdown, readTranscriptFacts } from "../src/handoff/transcript";
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

describe("compact mode", () => {
  it("never blocks Claude; reminds in the panel; records a compaction while a switch is due", () => {
    expect(compactReminder()).toBeUndefined();
    expect(markCompacted(project)).toBe(false); // no switch due: an ordinary /compact is ignored
    writeRequest("work", "compact");
    const at = readRequest()!.at;
    expect(onStop(project, false, "done")).toBeUndefined();
    expect(compactReminder()).toContain("/compact");
    expect(compactedSince(at)).toBe(false);
    expect(markCompacted(project)).toBe(true);
    expect(compactedSince(at)).toBe(true);
  });
});

describe("transcript facts", () => {
  const line = (o: object) => JSON.stringify(o);
  it("takes the person's latest requests verbatim and the files changed, skipping IDE tags and tool output", () => {
    const file = path.join(home, "t.jsonl");
    fs.writeFileSync(file, [
      line({ type: "user", message: { content: [{ type: "text", text: "<ide_opened_file>a.ts</ide_opened_file>" }, { type: "text", text: "add a divide-by-zero test" }] } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/p/calc.test.ts" } }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      line({ type: "user", isMeta: true, message: { content: "Caveat: meta" } }),
      line({ type: "user", message: { content: [{ type: "text", text: "AgentPool: the Claude account …" }] } }),
      "{broken",
      line({ type: "user", message: { content: "then make it pass" } }),
    ].join("\n"));
    const facts = readTranscriptFacts(file);
    expect(facts.requests).toEqual(["add a divide-by-zero test", "then make it pass"]);
    expect(facts.filesChanged).toEqual(["/p/calc.test.ts"]);
    expect(factsMarkdown(facts)).toContain("## Latest requests (verbatim)");
    expect(readTranscriptFacts(path.join(home, "missing.jsonl"))).toEqual({ requests: [], filesChanged: [] });
  });

  it("appends the facts to the saved handoff and reports it captured", () => {
    writeRequest("work");
    const at = readRequest()!.at;
    expect(handoffCapturedSince(at)).toBe(false);
    onStop(project, true, `${HANDOFF_MARKER}\n## Goal\nx`, Date.now(), "## Latest requests (verbatim)\n1. do y");
    expect(fs.readFileSync(handoffFile(project), "utf8")).toMatch(/## Goal\nx\n\n## Latest requests \(verbatim\)\n1\. do y/);
    expect(handoffCapturedSince(at)).toBe(true);
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
    const env = { ...process.env, AGENT_POOL_HOME: home, CLAUDE_PROJECT_DIR: path.join(__dirname, "..") };
    const run = (mode: string, input: object) =>
      execFileSync(launcher, [mode], { input: JSON.stringify(input), env }).toString();
    writeRequest("work");
    const blocked = JSON.parse(run("stop", { stop_hook_active: false, last_assistant_message: "ok" }));
    expect(blocked.decision).toBe("block");
    expect(run("stop", { stop_hook_active: true, last_assistant_message: `${HANDOFF_MARKER}\nstep 3 next` })).toBe("");
    expect(fs.existsSync(handoffFile(path.join(__dirname, "..")))).toBe(true);
    const started = run("session-start", { source: "startup" });
    expect(started).toContain("step 3 next");
    expect(started).toContain("## Repository now"); // the repo root is a git repository
    expect(run("session-start", { source: "startup" })).toBe("");
  });

  it("compact mode: a reminder after each reply, facts and a switch signal after /compact", () => {
    const built = path.join(__dirname, "..", "dist", "handoff-hook.js");
    if (!fs.existsSync(built) || process.platform === "win32") return;
    const launcher = writeLauncher(built, process.execPath);
    const env = { ...process.env, AGENT_POOL_HOME: home, CLAUDE_PROJECT_DIR: path.join(__dirname, "..") };
    const run = (mode: string, input: object) =>
      execFileSync(launcher, [mode], { input: JSON.stringify(input), env }).toString();
    writeRequest("work", "compact");
    expect(JSON.parse(run("stop", { stop_hook_active: false })).systemMessage).toContain("/compact");
    const after = run("session-start", { source: "compact" });
    expect(after).toContain("compacted before switching");
    expect(fs.existsSync(path.join(home, "handoff", "compacted.json"))).toBe(true);
  });
});
