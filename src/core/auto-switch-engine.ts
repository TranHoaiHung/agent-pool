import { AccountMeta, maxUsed, UsageRecord } from "./types";

export interface DecideInput {
  /** Accounts of one provider in priority order, highest first. */
  accounts: AccountMeta[];
  usage: Record<string, UsageRecord>;
  activeId: string | undefined;
  thresholdPercent: number;
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

/**
 * Decides what auto switch does for one provider. It follows the user's priority order,
 * not the account with the most room: the first eligible account down the list wins.
 */
export function decide(input: DecideInput): Decision {
  const { accounts, usage, activeId, thresholdPercent, now } = input;
  if (!activeId || (input.quietUntil && now < input.quietUntil)) {
    return { action: "none" };
  }
  const active = accounts.find((a) => a.id === activeId);
  if (!active) {
    return { action: "none" }; // an account nobody enrolled is not watched
  }

  const used = (id: string): number | undefined => {
    const snap = usage[id]?.snapshot;
    if (!snap || now - snap.fetchedAt > input.maxAgeMs) {
      return undefined;
    }
    return maxUsed(snap, now);
  };
  const eligible = (a: AccountMeta, limit: number): boolean => {
    if (a.id === activeId || !a.inRotation || a.needsReauth) {
      return false;
    }
    const u = used(a.id);
    return u !== undefined && u < limit;
  };

  const activeUsed = used(activeId);
  if (activeUsed === undefined) {
    return { action: "none" };
  }

  if (activeUsed >= thresholdPercent) {
    const next = accounts.find((a) => eligible(a, thresholdPercent));
    if (next) {
      return { action: "switch", toId: next.id, reason: "threshold", usedPercent: activeUsed };
    }
    // Never call the pool exhausted on readings that are missing or too old.
    const unknown = accounts
      .filter((a) => a.id !== activeId && a.inRotation && !a.needsReauth && used(a.id) === undefined)
      .map((a) => a.id);
    if (unknown.length > 0) {
      return { action: "refresh", ids: unknown };
    }
    const soonestReset = soonestRecovery(accounts, usage, now, thresholdPercent);
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
      .find((a) => eligible(a, thresholdPercent - RETURN_MARGIN));
    if (preferred) {
      return { action: "switch", toId: preferred.id, reason: "preferred", usedPercent: activeUsed };
    }
  }
  return { action: "none" };
}

/** The earliest time any account in rotation gets below the threshold again. */
function soonestRecovery(
  accounts: AccountMeta[],
  usage: Record<string, UsageRecord>,
  now: number,
  threshold: number
): number | undefined {
  let soonest: number | undefined;
  for (const a of accounts) {
    if (!a.inRotation || a.needsReauth) {
      continue;
    }
    const windows = usage[a.id]?.snapshot?.windows ?? [];
    // The account recovers when its last window at/over the threshold resets.
    const blocking = windows.filter(
      (w) => w.percent >= threshold && w.resetsAt !== null && w.resetsAt > now
    );
    if (blocking.length === 0) {
      continue;
    }
    const at = Math.max(...blocking.map((w) => w.resetsAt as number));
    soonest = soonest === undefined ? at : Math.min(soonest, at);
  }
  return soonest;
}
