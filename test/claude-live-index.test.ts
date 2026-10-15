import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PoolStore } from "../src/core/pool-store";
import { AccountMeta, AccountSecret, ClaudeOAuth, Identity } from "../src/core/types";
import { ClaudeLiveIndex } from "../src/providers/claude/claude-live-index";
import { ClaudeSlot } from "../src/providers/claude/claude-paths";

// The two side effects of ClaudeLiveIndex: reading the slot (Keychain) and asking Anthropic.
const live = vi.hoisted(() => ({ doc: undefined as { claudeAiOauth?: unknown } | undefined }));
const profile = vi.hoisted(() => ({ impl: vi.fn<(token: string) => Promise<Identity>>() }));
vi.mock("../src/providers/claude/claude-credential-store", () => ({
  readLive: async () => ({ doc: live.doc, source: live.doc ? "keychain" : "none" }),
}));
vi.mock("../src/providers/claude/claude-api", () => ({
  fetchClaudeIdentity: (token: string) => profile.impl(token),
}));


const slot: ClaudeSlot = { name: "global", dir: "/fake/.claude", service: "x", configFile: "/fake/.claude.json" };
const oauth = (tag: string, expiresAt = 1_000): ClaudeOAuth => ({ accessToken: `${tag}-access`, refreshToken: `${tag}-refresh`, expiresAt });
const meta = (id: string): AccountMeta => ({ id, provider: "claude", label: id, identityKey: `uuid-${id}:org`, inRotation: true, addedAt: 0 });

let secrets: Map<string, AccountSecret>;
let index: ClaudeLiveIndex;

beforeEach(async () => {
  secrets = new Map();
  const pool = new PoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ap-idx-")), "pool.json"));
  await pool.mutate((d) => (d.accounts = [meta("A"), meta("B")]));
  const vault = {
    get: async (id: string) => secrets.get(id),
    set: async (id: string, s: AccountSecret) => void secrets.set(id, s),
    delete: async (id: string) => void secrets.delete(id),
  };
  index = new ClaudeLiveIndex({ pool, vault, log: () => undefined, enroll: async () => meta("x") });
  profile.impl.mockReset();
  live.doc = undefined;
});

describe("ClaudeLiveIndex.owner", () => {
  it("matches by refresh-token fingerprint without any network call", async () => {
    secrets.set("A", { kind: "claude", oauth: oauth("A") });
    live.doc = { claudeAiOauth: oauth("A") };
    expect((await index.owner(slot)).accountId).toBe("A");
    expect(profile.impl).not.toHaveBeenCalled();
  });

  it("after Claude Code rotated the token, identifies via /profile and syncs the vault", async () => {
    secrets.set("B", { kind: "claude", oauth: oauth("B-old", 1_000) });
    live.doc = { claudeAiOauth: oauth("B-new", 2_000) };
    profile.impl.mockResolvedValue({ identityKey: "uuid-B:org", email: "b@x" });
    expect((await index.owner(slot)).accountId).toBe("B");
    expect((secrets.get("B") as { oauth: ClaudeOAuth }).oauth.refreshToken).toBe("B-new-refresh");
  });

  it("a failed lookup is 'unresolved', never 'not saved', and is not cached", async () => {
    live.doc = { claudeAiOauth: oauth("Z") };
    profile.impl.mockRejectedValueOnce(new Error("429"));
    const first = await index.owner(slot);
    expect(first).toMatchObject({ accountId: undefined, unresolved: true });
    profile.impl.mockResolvedValueOnce({ identityKey: "uuid-A:org" });
    expect((await index.owner(slot)).accountId).toBe("A"); // asked again, not cached
  });

  it("caches a resolved owner while the slot's token is unchanged", async () => {
    live.doc = { claudeAiOauth: oauth("A2") };
    profile.impl.mockResolvedValue({ identityKey: "uuid-A:org" });
    await index.owner(slot);
    await index.owner(slot);
    expect(profile.impl).toHaveBeenCalledTimes(1);
  });

  it("an empty slot has no owner", async () => {
    expect(await index.owner(slot)).toEqual({});
  });
});

describe("ClaudeLiveIndex.sync", () => {
  it("never writes an older generation over a newer one", async () => {
    secrets.set("A", { kind: "claude", oauth: oauth("A-newer", 5_000) });
    await index.sync("A", oauth("A-older", 4_000));
    expect((secrets.get("A") as { oauth: ClaudeOAuth }).oauth.refreshToken).toBe("A-newer-refresh");
    await index.sync("A", oauth("A-newest", 6_000));
    expect((secrets.get("A") as { oauth: ClaudeOAuth }).oauth.refreshToken).toBe("A-newest-refresh");
  });
});
