import * as fs from "fs";

/**
 * Facts the hook takes from Claude Code's session transcript (JSONL) so a handoff does not rest
 * on Claude's summary alone: the person's latest requests, verbatim, and the files changed.
 * The format is Claude Code's internal one; anything unrecognised is skipped, never fatal.
 */
export interface TranscriptFacts {
  requests: string[];
  filesChanged: string[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_REQUESTS = 3;
const MAX_REQUEST_CHARS = 1_500;
const MAX_FILES = 40;
/** Long sessions: only the tail is read. */
const TAIL_BYTES = 4 * 1024 * 1024;

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: { file_path?: string; notebook_path?: string };
}
interface Line {
  type?: string;
  isMeta?: boolean;
  message?: { role?: string; content?: string | Block[] };
}

export function readTranscriptFacts(transcriptPath: string | undefined): TranscriptFacts {
  const facts: TranscriptFacts = { requests: [], filesChanged: [] };
  if (!transcriptPath) {
    return facts;
  }
  let text: string;
  try {
    text = readTail(transcriptPath);
  } catch {
    return facts;
  }
  const requests: string[] = [];
  const files = new Set<string>();
  for (const raw of text.split("\n")) {
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue; // a partial first line from the tail, or a line still being written
    }
    const content = line.message?.content;
    if (line.type === "user" && !line.isMeta) {
      // A prompt is several text blocks; the IDE adds tagged ones (<ide_opened_file> …) first.
      const blocks = typeof content === "string" ? [content] : (content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "");
      const said = blocks.filter(isPersonsWords).join("\n").trim();
      if (said) {
        requests.push(said.slice(0, MAX_REQUEST_CHARS));
      }
    } else if (line.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        const file = block.input?.file_path ?? block.input?.notebook_path;
        if (block.type === "tool_use" && EDIT_TOOLS.has(block.name ?? "") && file) {
          files.add(file);
        }
      }
    }
  }
  facts.requests = requests.slice(-MAX_REQUESTS);
  facts.filesChanged = [...files].slice(-MAX_FILES);
  return facts;
}

/** The person's own words: not empty, not a tagged IDE/system block, not a hook message. */
function isPersonsWords(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !t.includes("AgentPool:") && !t.startsWith("<") && !t.startsWith("Stop hook");
}

function readTail(file: string): string {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Markdown appended to a handoff. */
export function factsMarkdown(facts: TranscriptFacts): string {
  const parts: string[] = [];
  if (facts.requests.length) {
    parts.push("## Latest requests (verbatim)", ...facts.requests.map((r, i) => `${i + 1}. ${r.replace(/\n/g, "\n   ")}`));
  }
  if (facts.filesChanged.length) {
    parts.push("## Files changed in that session", ...facts.filesChanged.map((f) => `- ${f}`));
  }
  return parts.join("\n");
}
