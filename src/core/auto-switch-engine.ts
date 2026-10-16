import { AccountMeta, maxUsed, UsageRecord, UsageSnapshot, UsageWindow } from "./types";

export interface DecideInput {
  /** Accounts of one provider in priority order, highest first. */
  accounts: AccountMeta[];
  usage: Record<string, UsageRecord>;
  activeId: string | undefined;
  /** Applies to the short (5-hour) limits. */
  thresholdPercent: number;
  /** Applies to the long (weekly, per-model) limits; never below `thresholdPercent`. Default 98. */
  longThresholdPercent?: number;
  returnToPreferred: boolean;
  /** A reading older than this is not trusted for a decision. */
  maxAgeMs: number;
  now: number;
  /** Nothing switches before this time (cooldown after the last switch). */
  quietUntil?: number;
}

export type Decision =
  | { action: "none" }
  | { action: "switch"; toId: string; reason: "threshold" | "preferred"; usedPercent: number }
  | { action: "exhausted"; soonestReset?: number; noticeKey: string }
  /** Candidates have no fresh reading: read them before deciding anything. */
  | { action: "refresh"; ids: string[] };

/** Hysteresis: a higher-priority account is gone back to only this far below the threshold. */
export const RETURN_MARGIN = 10;

/** With no account under the threshold, a switch only goes to one at least this much emptier. */
export const BEST_ROOM_MARGIN = 10;

/**
 * Default for weekly and per-model limits, which only matter once nearly used up: the main
 * threshold is for the 5-hour limit (people can change this one in settings).
 */
export const WEEKLY_THRESHOLD = 98;

/** Short windows (5h, 3h, 90m) restart within hours; weekly and monthly ones do not. */
export function isShortWindow(w: UsageWindow): boolean {
  return w.kind === "session" || /^\d+(h|m)$/.test(w.label);
}

/**
 * How close an account is to switching, on one scale: 100 means a limit reached its threshold.
 * A 5-hour limit is measured against the threshold the person set; a weekly limit against
 * WEEKLY_THRESHOLD — 60% of a week used still leaves a lot of room.
 */
export function pressure(snapshot: UsageSnapshot | undefined, now: number, threshold: number, longThreshold: number): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  if (snapshot.limitReached) {
    return 1_000;
  }
  let max = 0;
  for (const w of snapshot.windows) {
    if (w.resetsAt !== null && w.resetsAt <= now) {
      continue; // already reset
    }
    const limit = isShortWindow(w) ? threshold : longThreshold;
    max = Math.max(max, (w.percent / limit) * 100);
  }
  return max;
}

/** Pressure expressed back as a percent of the short threshold (the scale people set). */
export function effectivePercent(snapshot: UsageSnapshot | undefined, now: number, threshold: number, longThreshold: number): number | undefined {
  const p = pressure(snapshot, now, threshold, longThreshold);
  return p === undefined ? undefined : Math.round((p * threshold) / 100);
}

/**
 * Decides what auto switch does for one provider. It follows the user's priority order,
 * not the account with the most room: the first eligible account down the list wins.
 */
export function decide(input: DecideInput): Decision {
  const { accounts, usage, activeId, thresholdPercent, now } = input;
  const longThreshold = Math.max(thresholdPercent, input.longThresholdPercent ?? WEEKLY_THRESHOLD);
  if (!activeId || (input.quietUntil && now < input.quietUntil)) {
    return { action: "none" };
  }
  const active = accounts.find((a) => a.id === activeId);
  if (!active) {
    return { action: "none" }; // an account nobody enrolled is not watched
  }

  const fresh = (id: string): UsageSnapshot | undefined => {
    const snap = usage[id]?.snapshot;
    return snap && now - snap.fetchedAt <= input.maxAgeMs ? snap : undefined;
  };
  const press = (id: string): number | undefined => pressure(fresh(id), now, thresholdPercent, longThreshold);
  const candidate = (a: AccountMeta): boolean => a.id !== activeId && a.inRotation && !a.needsReauth;
  /** Points of the short threshold, on the pressure scale. */
  const points = (n: number): number => (n / thresholdPercent) * 100;

  const activePressure = press(activeId);
  if (activePressure === undefined) {
    return { action: "none" };
  }
  const usedPercent = maxUsed(fresh(activeId), now) ?? 0;

  if (activePressure >= 100) {
    const next = accounts.find((a) => candidate(a) && (press(a.id) ?? Infinity) < 100);
    if (next) {
      return { action: "switch", toId: next.id, reason: "threshold", usedPercent };
    }
    // Never call the pool exhausted on readings that are missing or too old.
    const unknown = accounts.filter((a) => candidate(a) && press(a.id) === undefined).map((a) => a.id);
    if (unknown.length > 0) {
      return { action: "refresh", ids: unknown };
    }
    // Nothing under the thresholds: still move to the account with the most room when it is
    // clearly emptier (and has no limit used up), so the current one is not run to 100%.
    // The margin keeps two similar accounts from trading places on every reading.
    const roomiest = accounts
      .filter(candidate)
      .map((a) => ({ a, p: press(a.id) as number, u: maxUsed(fresh(a.id), now) ?? 100 }))
      .filter(({ p, u }) => p <= activePressure - points(BEST_ROOM_MARGIN) && u < 100)
      .sort((x, y) => x.p - y.p)[0];
    if (roomiest) {
      return { action: "switch", toId: roomiest.a.id, reason: "threshold", usedPercent };
    }
    const soonestReset = soonestRecovery(accounts, usage, now, thresholdPercent, longThreshold);
    return {
      action: "exhausted",
      soonestReset,
      noticeKey: `${activeId}:${soonestReset ?? "none"}`,
    };
  }

  if (input.returnToPreferred) {
    const activeIndex = accounts.indexOf(active);
    const preferred = accounts
      .slice(0, activeIndex)
      .find((a) => candidate(a) && (press(a.id) ?? Infinity) < 100 - points(RETURN_MARGIN));
    if (preferred) {
      return { action: "switch", toId: preferred.id, reason: "preferred", usedPercent };
    }
  }
  return { action: "none" };
}

/** The earliest time any account in rotation gets below the threshold again. */
function soonestRecovery(
  accounts: AccountMeta[],
  usage: Record<string, UsageRecord>,
  now: number,
  threshold: number,
  longThreshold: number
): number | undefined {
  let soonest: number | undefined;
  for (const a of accounts) {
    if (!a.inRotation || a.needsReauth) {
      continue;
    }
    const windows = usage[a.id]?.snapshot?.windows ?? [];
    // The account recovers when its last window at/over the threshold resets.
    const blocking = windows.filter(
      (w) => w.percent >= (isShortWindow(w) ? threshold : longThreshold) && w.resetsAt !== null && w.resetsAt > now
    );
    if (blocking.length === 0) {
      continue;
    }
    const at = Math.max(...blocking.map((w) => w.resetsAt as number));
    soonest = soonest === undefined ? at : Math.min(soonest, at);
  }
  return soonest;
}
