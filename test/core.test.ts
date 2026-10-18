import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { decide, DecideInput } from "../src/core/auto-switch-engine";
import { LockBusyError, withLocks } from "../src/core/dir-lock";
import { move, ordered, placeBefore } from "../src/core/priority";
import { AccountMeta, emptyPool, maxUsed, UsageRecord } from "../src/core/types";

const NOW = 1_800_000_000_000;

function account(id: string, extra: Partial<AccountMeta> = {}): AccountMeta {
  return { id, provider: "claude", label: id, identityKey: id, inRotation: true, addedAt: 0, ...extra };
}

function usage(percent: number, resetInMin = 60, at = NOW): UsageRecord {
  return { snapshot: { fetchedAt: at, windows: [{ kind: "session", label: "5h", percent, resetsAt: NOW + resetInMin * 60_000 }] } };
}

function input(over: Partial<DecideInput>): DecideInput {
  return {
    accounts: [account("B"), account("A"), account("C")],
    usage: {},
    activeId: "B",
    thresholdPercent: 95,
    returnToPreferred: true,
    maxAgeMs: 600_000,
    now: NOW,
    ...over,
  };
}

describe("decide (auto switch)", () => {
  it("follows the priority order, not the account with the most room", () => {
    const d = decide(input({ usage: { B: usage(96), A: usage(80), C: usage(0) } }));
    expect(d).toMatchObject({ action: "switch", toId: "A", reason: "threshold" });
  });

  it("skips excluded, re-auth and full accounts", () => {
    const accounts = [account("B"), account("A", { inRotation: false }), account("C", { needsReauth: true }), account("D")];
    const d = decide(input({ accounts, usage: { B: usage(99), A: usage(0), C: usage(0), D: usage(95), } }));
    expect(d.action).toBe("exhausted");
  });

  it("does nothing below the threshold or during the cooldown", () => {
    expect(decide(input({ usage: { B: usage(94), A: usage(0) } })).action).toBe("none");
    expect(decide(input({ usage: { B: usage(99), A: usage(0) }, quietUntil: NOW + 1 })).action).toBe("none");
  });

  it("never trusts stale readings", () => {
    const stale = usage(0, 60, NOW - 3_600_000);
    // A stale candidate is read again first; the pool is never called exhausted on it.
    expect(decide(input({ usage: { B: usage(99), A: stale, C: usage(99) } }))).toEqual({ action: "refresh", ids: ["A"] });
    expect(decide(input({ usage: { B: stale } })).action).toBe("none");
  });

  it("returns to a preferred account once it has room, with hysteresis", () => {
    const base = { activeId: "A" };
    expect(decide(input({ ...base, usage: { A: usage(10), B: usage(90) } })).action).toBe("none");
    expect(decide(input({ ...base, usage: { A: usage(10), B: usage(20) } }))).toMatchObject({ action: "switch", toId: "B", reason: "preferred" });
    expect(decide(input({ ...base, returnToPreferred: false, usage: { A: usage(10), B: usage(0) } })).action).toBe("none");
  });

  it("reports the soonest recovery when everything is full", () => {
    const d = decide(input({ usage: { B: usage(99, 120), A: usage(97, 30), C: usage(100, 300) } }));
    expect(d).toMatchObject({ action: "exhausted", soonestReset: NOW + 30 * 60_000 });
  });

  it("ignores windows that already reset", () => {
    const rec: UsageRecord = { snapshot: { fetchedAt: NOW, windows: [{ kind: "session", label: "5h", percent: 100, resetsAt: NOW - 1 }] } };
    expect(maxUsed(rec.snapshot, NOW)).toBe(0);
  });
});

describe("priority", () => {
  it("orders, moves and places accounts", () => {
    const data = emptyPool();
    data.accounts = [account("A", { addedAt: 1 }), account("B", { addedAt: 2 }), account("C", { addedAt: 3 })];
    data.order.claude = ["B", "A"];
    expect(ordered(data, "claude").map((a) => a.id)).toEqual(["B", "A", "C"]);
    move(data, "C", -2);
    expect(data.order.claude).toEqual(["C", "B", "A"]);
    placeBefore(data, "A", "C");
    expect(data.order.claude).toEqual(["A", "C", "B"]);
    placeBefore(data, "A", undefined);
    expect(data.order.claude).toEqual(["C", "B", "A"]);
  });
});

describe("dir locks", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-pool-"));

  it("excludes a second holder and releases afterwards", async () => {
    const lock = { path: path.join(tmp(), "x.lock"), staleMs: 60_000, heartbeatMs: 1_000 };
    await withLocks([lock], 1_000, async () => {
      await expect(withLocks([lock], 300, async () => 1)).rejects.toBeInstanceOf(LockBusyError);
    });
    expect(fs.existsSync(lock.path)).toBe(false);
    expect(await withLocks([lock], 300, async () => 2)).toBe(2);
  });

  it("takes over a stale lock", async () => {
    const lock = { path: path.join(tmp(), "y.lock"), staleMs: 1_000, heartbeatMs: 500 };
    fs.mkdirSync(lock.path);
    const old = new Date(Date.now() - 5_000);
    fs.utimesSync(lock.path, old, old);
    expect(await withLocks([lock], 300, async () => "ok")).toBe("ok");
  });
});

describe("defaultLabel", () => {
  it("disambiguates the same local part across domains", async () => {
    const { defaultLabel } = await import("../src/account-service");
    const first = account("x", { label: "dev" });
    expect(defaultLabel({ identityKey: "k", email: "dev@acme.io" }, [])).toBe("dev");
    expect(defaultLabel({ identityKey: "k", email: "dev@acmesoftware.com" }, [first])).toBe("dev@acmesoftware");
  });
});

describe("pendingReload", () => {
  it("flags windows started before a switch that needs a reload, and stays until reload", async () => {
    const { AccountService } = await import("../src/account-service");
    const { PoolStore } = await import("../src/core/pool-store");
    const pool = new PoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rl-")), "pool.json"));
    const service = new AccountService(pool, { get: async () => undefined, set: async () => {}, delete: async () => {} }, () => {});
    await pool.mutate((d) => (d.accounts = [account("A"), account("B")]));
    const outcomes = [{ needsReload: true, notes: [] }, { needsReload: false, notes: [] }];
    service.register({ id: "claude", switchTo: async () => outcomes.shift()!, activeAccountId: async () => undefined } as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(service.pendingReload("claude")).toBe(false);
    await service.switchTo("A", false);
    expect(service.pendingReload("claude")).toBe(true);
    await service.switchTo("B", false); // no reload needed, but the earlier one still is
    expect(service.pendingReload("claude")).toBe(true);
    const fresh = new AccountService(pool, { get: async () => undefined, set: async () => {}, delete: async () => {} }, () => {});
    expect(fresh.pendingReload("claude")).toBe(false); // a reloaded window starts after it
  });
});

describe("decide with a user threshold", () => {
  it("switches at 98% only from 98%, and at 100% only once the limit is used up", () => {
    expect(decide(input({ thresholdPercent: 98, usage: { B: usage(97), A: usage(0) } })).action).toBe("none");
    expect(decide(input({ thresholdPercent: 98, usage: { B: usage(98), A: usage(0) } }))).toMatchObject({ action: "switch", toId: "A" });
    expect(decide(input({ thresholdPercent: 100, usage: { B: usage(99), A: usage(0) } })).action).toBe("none");
    expect(decide(input({ thresholdPercent: 100, usage: { B: usage(100), A: usage(0) } }))).toMatchObject({ action: "switch", toId: "A" });
  });
});

describe("decide with per-window thresholds (5h vs weekly)", () => {
  const two = [account("B"), account("A")];
  const weekly = (five: number, seven: number): UsageRecord => ({
    snapshot: { fetchedAt: NOW, windows: [
      { kind: "session", label: "5h", percent: five, resetsAt: NOW + 3_600_000 },
      { kind: "weekly_all", label: "7d", percent: seven, resetsAt: NOW + 86_400_000 },
    ] },
  });

  it("threshold 50: an account at 5h 25% / 7d 60% is a good target (weekly limits switch at 98%)", () => {
    const d = decide(input({ accounts: two, thresholdPercent: 50, usage: { B: weekly(80, 20), A: weekly(25, 60) } }));
    expect(d).toMatchObject({ action: "switch", toId: "A", reason: "threshold" });
  });

  it("…and once on it, AgentPool stays without warnings", () => {
    const d = decide(input({ accounts: two, activeId: "A", thresholdPercent: 50, usage: { A: weekly(25, 60), B: weekly(80, 20) } }));
    expect(d.action).toBe("none");
  });

  it("a weekly limit switches only at 98%", () => {
    expect(decide(input({ accounts: two, thresholdPercent: 50, usage: { B: weekly(10, 97), A: weekly(10, 10) } })).action).toBe("none");
    expect(decide(input({ accounts: two, thresholdPercent: 50, usage: { B: weekly(10, 98), A: weekly(10, 10) } }))).toMatchObject({ action: "switch", toId: "A" });
  });

  it("the weekly threshold can be set, never below the 5-hour one", () => {
    expect(decide(input({ accounts: two, thresholdPercent: 50, longThresholdPercent: 70, usage: { B: weekly(10, 75), A: weekly(10, 10) } })).action).toBe("switch");
    expect(decide(input({ accounts: two, thresholdPercent: 90, longThresholdPercent: 60, usage: { B: weekly(10, 80), A: weekly(10, 10) } })).action).toBe("none");
  });

  it("a 5-hour threshold above 98% applies to weekly limits too", () => {
    expect(decide(input({ accounts: two, thresholdPercent: 100, usage: { B: weekly(10, 99), A: weekly(10, 10) } })).action).toBe("none");
  });

  it("with nothing under the thresholds, moves to a clearly emptier account, never between similar ones", () => {
    const d = decide(input({ accounts: two, thresholdPercent: 50, usage: { B: weekly(80, 20), A: weekly(65, 20) } }));
    expect(d).toMatchObject({ action: "switch", toId: "A" });
    const e = decide(input({ accounts: two, thresholdPercent: 50, usage: { B: weekly(80, 20), A: weekly(76, 20) } }));
    expect(e.action).toBe("exhausted");
  });
});

describe("exact reload check", () => {
  it("a provider's own check wins over the time-based flag", async () => {
    const { AccountService } = await import("../src/account-service");
    const { PoolStore } = await import("../src/core/pool-store");
    const pool = new PoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ap-rc-")), "pool.json"));
    const service = new AccountService(pool, { get: async () => undefined, set: async () => {}, delete: async () => {} }, () => {});
    await new Promise((r) => setTimeout(r, 5));
    await pool.mutate((d) => (d.lastSwitch.claude = { at: Date.now(), toId: "x", automatic: true, reloadAt: Date.now() }));
    expect(service.pendingReload("claude")).toBe(true); // time-based: started before reloadAt
    let settingChanged = false;
    service.setReloadCheck("claude", () => settingChanged);
    expect(service.pendingReload("claude")).toBe(false); // same slot setting as at start: no reload
    settingChanged = true;
    expect(service.pendingReload("claude")).toBe(true);
  });
});
