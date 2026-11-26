import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PoolStore } from "../src/core/pool-store";
import { AccountMeta, AccountSecret, ClaudeOAuth } from "../src/core/types";
import { ClaudeLiveIndex } from "../src/providers/claude/claude-live-index";
import { slotForDir } from "../src/providers/claude/claude-paths";
import { ClaudeSlotWriter } from "../src/providers/claude/claude-slot-writer";
import { HttpError } from "../src/providers/http";

// A login slot whose login died (its sign-in reached its time limit): the slot lives in memory,
// Anthropic is faked. Real dir locks in a temp folder.
const store = vi.hoisted(() => ({ doc: undefined as { claudeAiOauth?: unknown } | undefined, others: new Map<string, { claudeAiOauth?: unknown }>(), mainDir: "" }));
const api = vi.hoisted(() => ({ dead: new Set<string>(), identities: new Map<string, string>(), fail: undefined as Error | undefined }));
vi.mock("../src/providers/claude/claude-credential-store", () => ({
  readLive: async (s: { dir: string }) => {
    const doc = s.dir === store.mainDir ? store.doc : store.others.get(s.dir);
    return { doc, source: doc ? "keychain" : "none" };
  },
  writeLive: async (s: { dir: string }, doc: { claudeAiOauth?: unknown }) => void (s.dir === store.mainDir ? (store.doc = doc) : store.others.set(s.dir, doc)),
  clearLive: async () => void (store.doc = undefined),
  credentialFile: () => "/nonexistent/.credentials.json",
  stowFallbackFile: () => "",
}));
vi.mock("../src/providers/claude/claude-api", async (actual) => ({
  ...(await actual<typeof import("../src/providers/claude/claude-api")>()),
  refreshClaude: async (o: ClaudeOAuth) => {
    if (api.fail) {
      throw api.fail;
    }
    if (api.dead.has(o.refreshToken)) {
      throw new HttpError(400, 'HTTP 400: {"error": "invalid_grant", "error_description": "Refresh token expired"}');
    }
    return { ...o, accessToken: `${o.accessToken}+`, refreshToken: `${o.refreshToken}+`, expiresAt: Date.now() + 8 * 3_600_000 };
  },
  fetchClaudeIdentity: async (token: string) => {
    const key = api.identities.get(token);
    if (!key) throw new HttpError(401, "HTTP 401: token expired");
    return { identityKey: key };
  },
}));

const meta = (id: string): AccountMeta => ({ id, provider: "claude", label: id, identityKey: `${id}:org`, inRotation: true, addedAt: 0 });
const soon = () => Date.now() + 60_000; // expiring: renewed before use
const far = () => Date.now() + 8 * 3_600_000;

let secrets: Map<string, AccountSecret>;
let writer: ClaudeSlotWriter;
let slot: ReturnType<typeof slotForDir>;
let enrolled: number;

beforeEach(async () => {
  process.env.AGENT_POOL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ap-home-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dead-slot-"));
  slot = slotForDir("vscode", dir);
  store.mainDir = dir;
  store.others.clear();
  secrets = new Map();
  enrolled = 0;
  store.doc = undefined;
  api.dead.clear();
  api.identities.clear();
  api.fail = undefined;
  const pool = new PoolStore(path.join(dir, "pool.json"));
  await pool.mutate((d) => (d.accounts = [meta("A"), meta("B")]));
  const vault = {
    get: async (id: string) => secrets.get(id),
    set: async (id: string, s: AccountSecret) => void secrets.set(id, s),
    delete: async (id: string) => void secrets.delete(id),
  };
  const ctx = { pool, vault, log: () => undefined, enroll: async () => (enrolled++, meta("X")) };
  writer = new ClaudeSlotWriter(ctx, new ClaudeLiveIndex(ctx));
});

describe("a dead login in a slot", () => {
  it("is replaced by a newer sign-in of the same account instead of failing forever", async () => {
    store.doc = { claudeAiOauth: { accessToken: "A-old", refreshToken: "A-old-r", expiresAt: soon() } };
    api.dead.add("A-old-r");
    secrets.set("A", { kind: "claude", oauth: { accessToken: "A-new", refreshToken: "A-new-r", expiresAt: far() } }); // signed in again

    const used = await writer.renewLive(slot, "A");

    expect(used.refreshToken).toBe("A-new-r");
    expect((store.doc?.claudeAiOauth as ClaudeOAuth).refreshToken).toBe("A-new-r");
  });

  it("never takes a saved login another slot holds (that would spend the terminal's token)", async () => {
    store.doc = { claudeAiOauth: { accessToken: "A-old", refreshToken: "A-old-r", expiresAt: soon() } };
    api.dead.add("A-old-r");
    const terminalLogin = { accessToken: "A-term", refreshToken: "A-term-r", expiresAt: soon() };
    secrets.set("A", { kind: "claude", oauth: terminalLogin }); // synced from the terminal's /login
    const terminal = slotForDir("global", fs.mkdtempSync(path.join(os.tmpdir(), "ap-term-")));
    store.others.set(terminal.dir, { claudeAiOauth: terminalLogin });

    await expect(writer.renewLive(slot, "A", [terminal])).rejects.toMatchObject({ deadLogin: true });
    expect((store.others.get(terminal.dir)?.claudeAiOauth as ClaudeOAuth).refreshToken).toBe("A-term-r"); // untouched
    expect((secrets.get("A") as { oauth: ClaudeOAuth }).oauth.refreshToken).toBe("A-term-r"); // not refreshed
  });

  it("leaves the slot alone on any other failure (e.g. a server error)", async () => {
    const before = { accessToken: "A-old", refreshToken: "A-500", expiresAt: soon() };
    store.doc = { claudeAiOauth: before };
    secrets.set("A", { kind: "claude", oauth: { accessToken: "A-new", refreshToken: "A-new-r", expiresAt: far() } });
    api.fail = new HttpError(500, "HTTP 500: overloaded");

    await expect(writer.renewLive(slot, "A")).rejects.toMatchObject({ status: 500 });
    expect((store.doc?.claudeAiOauth as ClaudeOAuth).refreshToken).toBe("A-500");
  });

  it("still reports a dead login when no newer sign-in exists", async () => {
    const dead = { accessToken: "A-old", refreshToken: "A-old-r", expiresAt: soon() };
    store.doc = { claudeAiOauth: dead };
    api.dead.add("A-old-r");
    secrets.set("A", { kind: "claude", oauth: dead });

    await expect(writer.renewLive(slot, "A")).rejects.toMatchObject({ deadLogin: true });
  });

  it("does not block switching: a dead login nobody can identify is simply overwritten", async () => {
    store.doc = { claudeAiOauth: { accessToken: "Z-old", refreshToken: "Z-old-r", expiresAt: Date.now() - 1_000 } };
    api.dead.add("Z-old-r");
    secrets.set("B", { kind: "claude", oauth: { accessToken: "B", refreshToken: "B-r", expiresAt: far() } });

    await writer.swapIn(slot, meta("B"));

    expect((store.doc?.claudeAiOauth as ClaudeOAuth).refreshToken).toBe("B-r");
    expect(enrolled).toBe(0); // nothing to save from a dead login
  });
});
