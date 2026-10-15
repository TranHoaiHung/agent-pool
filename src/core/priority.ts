import { AccountMeta, PoolData, ProviderId } from "./types";

/** Accounts of a provider in priority order, highest first; unknown ids are dropped. */
export function ordered(data: PoolData, provider: ProviderId): AccountMeta[] {
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
  return result.concat([...byId.values()].sort((a, b) => a.addedAt - b.addedAt));
}

/** Moves an account `delta` places (negative = higher priority). */
export function move(data: PoolData, id: string, delta: number): void {
  const account = data.accounts.find((a) => a.id === id);
  if (!account) {
    return;
  }
  const ids = ordered(data, account.provider).map((a) => a.id);
  const from = ids.indexOf(id);
  const to = Math.max(0, Math.min(ids.length - 1, from + delta));
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  data.order[account.provider] = ids;
}

/** Puts `id` right before `beforeId` (or last when undefined). */
export function placeBefore(data: PoolData, id: string, beforeId: string | undefined): void {
  const account = data.accounts.find((a) => a.id === id);
  if (!account) {
    return;
  }
  const ids = ordered(data, account.provider)
    .map((a) => a.id)
    .filter((x) => x !== id);
  const at = beforeId ? ids.indexOf(beforeId) : -1;
  ids.splice(at < 0 ? ids.length : at, 0, id);
  data.order[account.provider] = ids;
}
