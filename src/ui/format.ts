import { UsageRecord, UsageWindow } from "../core/types";

/** "2h10m", "35m", "3d4h" until `at`. */
export function until(at: number | null, now = Date.now()): string {
  if (at === null) {
    return "";
  }
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  }
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** A 10-cell text bar for tooltips. */
export function bar(percent: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

/** Windows worth showing: running ones, the 5h/7d first. */
export function shownWindows(windows: UsageWindow[], now = Date.now()): UsageWindow[] {
  const rank = (w: UsageWindow) => (w.label === "5h" ? 0 : w.label === "7d" ? 1 : 2);
  return windows
    .filter((w) => w.resetsAt === null || w.resetsAt > now)
    .filter((w) => w.percent > 0 || rank(w) < 2)
    .sort((a, b) => rank(a) - rank(b));
}

/** "5h 42% · 7d 18%" */
export function compactUsage(record: UsageRecord | undefined): string {
  const snap = record?.snapshot;
  if (!snap) {
    return record?.error ? "usage unavailable" : "reading…";
  }
  const parts = shownWindows(snap.windows).map((w) => `${w.label} ${w.percent}%`);
  return parts.length ? parts.join(" · ") : "no limits";
}

export function ago(at: number | undefined, now = Date.now()): string {
  if (!at) {
    return "never";
  }
  const s = Math.round((now - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3_600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3_600)}h ago`;
}
