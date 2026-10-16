import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { PoolStore } from "../src/core/pool-store";
import { AccountMeta, AccountSecret } from "../src/core/types";
import { readLive, writeLive } from "../src/providers/claude/claude-credential-store";
import { ClaudeLiveIndex } from "../src/providers/claude/claude-live-index";
import { slotForDir } from "../src/providers/claude/claude-paths";
import { ClaudeSlotWriter } from "../src/providers/claude/claude-slot-writer";

// Windows and Linux keep Claude Code's login in <config dir>/.credentials.json. macOS uses the
// Keychain, exercised separately on a throwaway item, so this runs everywhere else (CI matrix).
describe.skipIf(process.platform === "darwin")("Claude switch on the file store", () => {
  it("parks the outgoing login, keeps mcpOAuth, releases locks, and retires", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-file-slot-"));
    const slot = slotForDir("vscode", dir);
    const secrets = new Map<string, AccountSecret>();
    const vault = {
      get: async (id: string) => secrets.get(id),
      set: async (id: string, s: AccountSecret) => void secrets.set(id, s),
      delete: async (id: string) => void secrets.delete(id),
    };
    const pool = new PoolStore(path.join(dir, "pool.json"));
    const meta = (id: string): AccountMeta => ({ id, provider: "claude", label: id, identityKey: id, inRotation: true, addedAt: 0 });
    await pool.mutate((d) => (d.accounts = [meta("A"), meta("B")]));
    const far = Date.now() + 8 * 3_600_000;
    const A = { accessToken: "A-new", refreshToken: "A-refresh", expiresAt: far };
    const B = { accessToken: "B-access", refreshToken: "B-refresh", expiresAt: far };
    secrets.set("A", { kind: "claude", oauth: { ...A, accessToken: "A-old" } });
    secrets.set("B", { kind: "claude", oauth: B });
    const ctx = { pool, vault, log: () => undefined, enroll: async () => { throw new Error("must not enroll"); } };
    const index = new ClaudeLiveIndex(ctx);
    const writer = new ClaudeSlotWriter(ctx, index);

    await writeLive(slot, { claudeAiOauth: A, mcpOAuth: { server: "keep-me" } });
    expect(fs.existsSync(path.join(dir, ".credentials.json"))).toBe(true);
    await writer.swapIn(slot, meta("B"));

    const after = await readLive(slot);
    expect(after.source).toBe("file");
    expect(after.doc?.claudeAiOauth?.accessToken).toBe("B-access");
    expect(after.doc?.mcpOAuth).toEqual({ server: "keep-me" });
    expect((secrets.get("A") as { oauth: { accessToken: string } }).oauth.accessToken).toBe("A-new");
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
    expect(await writer.swapIn(slot, meta("B"))).toEqual([]); // already there: no-op

    await writer.retire(slot);
    expect((await readLive(slot)).source).toBe("none");
    expect((secrets.get("B") as { oauth: { accessToken: string } }).oauth.accessToken).toBe("B-access");
  });
});

describe.skipIf(process.platform === "darwin")("swap between the terminal and the VS Code slot", () => {
  it("exchanges accounts without a login ever live in both slots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-swap-"));
    const terminal = slotForDir("global", path.join(root, "global"));
    const vscodeSlot = slotForDir("vscode", path.join(root, "vscode"));
    const secrets = new Map<string, AccountSecret>();
    const vault = {
      get: async (id: string) => secrets.get(id),
      set: async (id: string, s: AccountSecret) => void secrets.set(id, s),
      delete: async (id: string) => void secrets.delete(id),
    };
    const pool = new PoolStore(path.join(root, "pool.json"));
    const meta = (id: string): AccountMeta => ({ id, provider: "claude", label: id, identityKey: id, inRotation: true, addedAt: 0 });
    await pool.mutate((d) => (d.accounts = [meta("A"), meta("B")]));
    const far = Date.now() + 8 * 3_600_000;
    const A = { accessToken: "A", refreshToken: "A-r", expiresAt: far };
    const B = { accessToken: "B", refreshToken: "B-r", expiresAt: far };
    secrets.set("A", { kind: "claude", oauth: A });
    secrets.set("B", { kind: "claude", oauth: B });
    const ctx = { pool, vault, log: () => undefined, enroll: async () => { throw new Error("must not enroll"); } };
    const writer = new ClaudeSlotWriter(ctx, new ClaudeLiveIndex(ctx));
    await writeLive(terminal, { claudeAiOauth: A });
    await writeLive(vscodeSlot, { claudeAiOauth: B });

    // The provider's exchange: empty the VS Code slot first, then terminal ← B, VS Code ← A.
    await writer.retire(vscodeSlot);
    expect((await readLive(vscodeSlot)).source).toBe("none");
    await writer.swapIn(terminal, meta("B"));
    await writer.swapIn(vscodeSlot, meta("A"));

    expect((await readLive(terminal)).doc?.claudeAiOauth?.refreshToken).toBe("B-r");
    expect((await readLive(vscodeSlot)).doc?.claudeAiOauth?.refreshToken).toBe("A-r");
  });
});
