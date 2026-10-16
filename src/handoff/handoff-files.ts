import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The handoff between two Claude accounts, kept in files so the extension and the hook
 * script (a separate process Claude Code runs) share it. No vscode import: the hook bundles this.
 */
const REQUEST_MAX_AGE_MS = 2 * 3_600_000;
const HANDOFF_MAX_AGE_MS = 24 * 3_600_000;
const ARCHIVE_DAYS = 7;

export interface HandoffRequest {
  at: number;
  /** Label of the account about to be left. */
  from: string;
}

export function handoffDir(): string {
  const home = process.env.AGENT_POOL_HOME || path.join(os.homedir(), ".agent-pool");
  return path.join(home, "handoff");
}

/** One handoff per project folder (case-insensitive on Windows). */
export function handoffFile(projectDir: string): string {
  const key = process.platform === "win32" ? projectDir.toLowerCase() : projectDir;
  const hash = crypto.createHash("sha256").update(path.resolve(key)).digest("hex").slice(0, 12);
  return path.join(handoffDir(), `${path.basename(projectDir) || "project"}-${hash}.md`);
}

export function writeRequest(from: string): void {
  fs.mkdirSync(handoffDir(), { recursive: true });
  const request: HandoffRequest = { at: Date.now(), from };
  fs.writeFileSync(path.join(handoffDir(), "request.json"), JSON.stringify(request));
}

export function clearRequest(): void {
  fs.rmSync(path.join(handoffDir(), "request.json"), { force: true });
}

export function readRequest(now = Date.now()): HandoffRequest | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(handoffDir(), "request.json"), "utf8")) as HandoffRequest;
    return now - r.at < REQUEST_MAX_AGE_MS ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Starts the reply that carries a handoff, so the Stop hook can tell it apart. */
export const HANDOFF_MARKER = "<!-- agentpool-handoff -->";

/**
 * Stop hook. When a switch is coming and this project has no handoff newer than the request,
 * it asks Claude to reply with one (a reply, not a file write: no permission prompt). On the
 * next Stop it saves that reply. Returns the block reason, or undefined to let Claude stop.
 */
export function onStop(
  projectDir: string,
  stopHookActive: boolean,
  lastMessage: string | undefined,
  now = Date.now()
): string | undefined {
  const request = readRequest(now);
  if (!request) {
    return undefined;
  }
  const file = handoffFile(projectDir);
  const marker = lastMessage?.indexOf(HANDOFF_MARKER) ?? -1;
  if (marker >= 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lastMessage!.slice(marker + HANDOFF_MARKER.length).trim() + "\n");
    return undefined;
  }
  if (stopHookActive || (fs.existsSync(file) && fs.statSync(file).mtimeMs >= request.at)) {
    return undefined;
  }
  return [
    `AgentPool: the Claude account "${request.from}" is close to its usage limit and will be switched soon.`,
    `Reply now with a handoff so the next session (on another account) can continue without rereading everything.`,
    `Start the reply with the exact line ${HANDOFF_MARKER} and then, in Markdown, at most ~60 lines:`,
    `1) Goal; 2) Done so far; 3) In progress — files, functions, exact next step; 4) Decisions and constraints;`,
    `5) Open questions; 6) How to verify (commands/tests). Do not use tools and do not continue other work in this reply.`,
  ].join("\n");
}

/** SessionStart hook: the handoff for this project as context, then archived (read once). */
export function takeHandoff(projectDir: string, now = Date.now()): string | undefined {
  const file = handoffFile(projectDir);
  let text: string;
  let mtime: number;
  try {
    text = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  archive(file, now);
  if (now - mtime > HANDOFF_MAX_AGE_MS || !text.trim()) {
    return undefined;
  }
  return [
    `AgentPool handoff — written ${new Date(mtime).toLocaleString()} by the previous Claude session on another account.`,
    `Continue this work from where it stopped. Check \`git status\`/\`git diff\` first: work may have continued after it was written.`,
    "",
    text.trim(),
  ].join("\n");
}

function archive(file: string, now: number): void {
  const dir = path.join(handoffDir(), "archive");
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(file, path.join(dir, `${now}-${path.basename(file)}`));
  for (const name of fs.readdirSync(dir)) {
    const at = Number(name.split("-")[0]);
    if (Number.isFinite(at) && now - at > ARCHIVE_DAYS * 86_400_000) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}
