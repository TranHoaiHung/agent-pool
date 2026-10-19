import { DEFAULT_GROUP, groupForWorkspace, groupName, groupsOn } from "../../core/groups";
import { PoolStore } from "../../core/pool-store";
import { groupSlotDir } from "./claude-paths";

/**
 * The account group of this VS Code window, fixed for the window's lifetime (Claude Code reads
 * its login folder when it starts): assigning the workspace to another group takes a reload.
 */
export class WindowGroup {
  readonly id: string;
  /** The reload for a reassignment was already asked for (once per window). */
  reloadAsked = false;

  constructor(
    private readonly pool: PoolStore,
    readonly workspaceKey: string | undefined
  ) {
    this.id = groupForWorkspace(pool.get(), workspaceKey);
  }

  /** Groups are in use (every window then gets its slot through its own environment). */
  on(): boolean {
    return groupsOn(this.pool.get());
  }

  isDefault(): boolean {
    return this.id === DEFAULT_GROUP;
  }

  name(): string {
    return groupName(this.pool.get(), this.id);
  }

  /** This window's slot folder. */
  dir(): string {
    return groupSlotDir(this.id);
  }

  /** The group the workspace is assigned to now; differs from `id` until the window reloads. */
  wanted(): string {
    return groupForWorkspace(this.pool.get(), this.workspaceKey);
  }
}
