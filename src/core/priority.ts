import { inGroup } from "./groups";
import { AccountMeta, PoolData, ProviderId } from "./types";

/**
 * Accounts of a provider in priority order, highest first; unknown ids are dropped. With a
 * group, only the accounts that group sees (Claude accounts of other groups are left out).
 */
export function ordered(data: PoolData, provider: ProviderId, group?: string): AccountMeta[] {
  const byId = new Map(
    data.accounts.filter((a) => a.provider === provider).map((a) => [a.id, a] as const)
  );
  const result: AccountMeta[] = [];
  for (const id of data.order[provider]) {
    const account = byId.get(id);
    if (account) {
      result.push(account);
      byId.delete(id);
    }
  }
  // Accounts missing from the order go last, oldest first.
  const all = result.concat([...byId.values()].sort((a, b) => a.addedAt - b.addedAt));
  return group === undefined ? all : all.filter((a) => inGroup(a, group));
}

/**
 * Reorders the accounts a group sees; the others keep their places in the shared order, so
 * one group's moves never shift another group's priorities.
 */
function reorder(data: PoolData, provider: ProviderId, group: string | undefined, change: (ids: string[]) => string[]): void {
  const all = ordered(data, provider).map((a) => a.id);
  const visible = new Set(ordered(data, provider, group).map((a) => a.id));
  const ids = all.filter((id) => visible.has(id));
  const next = change([...ids]);
  if (next.length !== ids.length) {
    return; // the account is not one this group sees
  }
  let i = 0;
  data.order[provider] = all.map((id) => (visible.has(id) ? next[i++] : id));
}

/** Moves an account `delta` places (negative = higher priority) among the group's accounts. */
export function move(data: PoolData, id: string, delta: number, group?: string): void {
  const account = data.accounts.find((a) => a.id === id);
  if (!account) {
    return;
  }
  reorder(data, account.provider, group, (ids) => {
    const from = ids.indexOf(id);
    if (from < 0) {
      return [];
    }
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    return ids;
  });
}

/** Puts `id` right before `beforeId` (or last when undefined) among the group's accounts. */
export function placeBefore(data: PoolData, id: string, beforeId: string | undefined, group?: string): void {
  const account = data.accounts.find((a) => a.id === id);
  if (!account) {
    return;
  }
  reorder(data, account.provider, group, (ids) => {
    if (!ids.includes(id)) {
      return [];
    }
    const rest = ids.filter((x) => x !== id);
    const at = beforeId ? rest.indexOf(beforeId) : -1;
    rest.splice(at < 0 ? rest.length : at, 0, id);
    return rest;
  });
}
