import { AccountMeta, PoolData, ProviderId } from "./types";

/**
 * Claude account groups: each group has its own VS Code login slot, its own accounts and its
 * own auto switch, and each workspace is assigned to one group. Accounts without a group
 * belong to the default one. Codex accounts are not grouped (visible in every group).
 */
export const DEFAULT_GROUP = "default";

export function groupOf(account: AccountMeta): string {
  return account.provider === "claude" ? account.group ?? DEFAULT_GROUP : DEFAULT_GROUP;
}

export function inGroup(account: AccountMeta, group: string): boolean {
  return account.provider !== "claude" || groupOf(account) === group;
}

/** Groups are in use once one exists besides the default one. */
export function groupsOn(data: PoolData): boolean {
  return (data.groups ?? []).length > 0;
}

export function groupName(data: PoolData, id: string): string {
  return data.groups?.find((g) => g.id === id)?.name ?? (id === DEFAULT_GROUP ? "Default" : id);
}

/** The group a workspace is assigned to (the default one when unassigned or the group is gone). */
export function groupForWorkspace(data: PoolData, workspaceKey: string | undefined): string {
  const id = workspaceKey ? data.workspaceGroups?.[workspaceKey] : undefined;
  return id && data.groups?.some((g) => g.id === id) ? id : DEFAULT_GROUP;
}

/** Key of per-group state in the pool (last switch, notices); the default group keeps the old keys. */
export function laneKey(provider: ProviderId, group: string): string {
  return provider === "claude" && group !== DEFAULT_GROUP ? `claude@${group}` : provider;
}

/** A folder-safe id for a new group name. */
export function newGroupId(name: string, data: PoolData): string {
  const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "group";
  const taken = new Set([DEFAULT_GROUP, ...(data.groups ?? []).map((g) => g.id)]);
  let id = base;
  for (let i = 2; taken.has(id); i++) {
    id = `${base}-${i}`;
  }
  return id;
}

/** Name of a group's VS Code slot folder under ~/.agent-pool (the default one is the original slot). */
export function groupSlotName(group: string): string {
  return group === DEFAULT_GROUP ? "claude-vscode" : `claude-group-${group}`;
}
