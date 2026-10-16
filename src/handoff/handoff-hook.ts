/**
 * Hook script Claude Code runs (bundled to dist/handoff-hook.js, copied to ~/.agent-pool/hooks).
 *   handoff-hook stop           → on Stop: asks Claude for a handoff when a switch is near, saves it
 *   handoff-hook session-start  → on SessionStart: prints the project's handoff into the context
 * Any failure exits 0 with no output, so a broken handoff never blocks Claude.
 */
import { execFileSync } from "child_process";
import { onStop, takeHandoff } from "./handoff-files";
import { factsMarkdown, readTranscriptFacts } from "./transcript";

interface HookInput {
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  transcript_path?: string;
  source?: string;
}

async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const input = await readStdin();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  if (mode === "stop") {
    // Transcript facts are read only when a handoff reply is being saved (it is cheap otherwise).
    const saving = input.last_assistant_message?.includes("agentpool-handoff") === true;
    const extra = saving ? factsMarkdown(readTranscriptFacts(input.transcript_path)) : "";
    const reason = onStop(projectDir, input.stop_hook_active === true, input.last_assistant_message, Date.now(), extra);
    if (reason) {
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
    }
  } else if (mode === "session-start" && input.source !== "compact") {
    const context = takeHandoff(projectDir);
    if (context) {
      process.stdout.write([context, gitSnapshot(projectDir)].filter(Boolean).join("\n\n"));
    }
  }
}

/** The repository as it is now: work may have continued after the handoff was written. */
function gitSnapshot(dir: string): string {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    const status = git("status", "--short").split("\n").slice(0, 40).join("\n");
    let log = "(no commits yet)";
    try {
      log = git("log", "--oneline", "-5");
    } catch {
      /* empty repository */
    }
    return ["## Repository now", "```", `$ git status --short`, status || "(clean)", `$ git log --oneline -5`, log, "```"].join("\n");
  } catch {
    return ""; // not a git repository, or git missing
  }
}

main().catch(() => process.exit(0));
