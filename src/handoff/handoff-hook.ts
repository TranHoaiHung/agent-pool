/**
 * Hook script Claude Code runs (bundled to dist/handoff-hook.js, copied to ~/.agent-pool/hooks).
 *   handoff-hook stop           → on Stop: asks Claude for a handoff when a switch is near, saves it
 *   handoff-hook session-start  → on SessionStart: prints the project's handoff into the context
 * Any failure exits 0 with no output, so a broken handoff never blocks Claude.
 */
import { onStop, takeHandoff } from "./handoff-files";

interface HookInput {
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
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
    const reason = onStop(projectDir, input.stop_hook_active === true, input.last_assistant_message);
    if (reason) {
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
    }
  } else if (mode === "session-start" && input.source !== "compact") {
    const context = takeHandoff(projectDir);
    if (context) {
      process.stdout.write(context);
    }
  }
}

main().catch(() => process.exit(0));
