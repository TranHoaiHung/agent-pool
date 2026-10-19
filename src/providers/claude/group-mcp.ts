import * as fs from "fs";
import { replaceFile } from "../../core/fs-utils";

type Servers = Record<string, unknown>;
type Config = { mcpServers?: Servers; projects?: Record<string, { mcpServers?: Servers }> } & Record<string, unknown>;

/**
 * Whether a server is shared under `rules`: names, `*` for all, `!name` to leave one out
 * (exclusions win), e.g. `["*", "!memory-server"]`.
 */
export function mcpShared(name: string, rules: string[]): boolean {
  if (rules.includes(`!${name}`)) {
    return false;
  }
  return rules.includes("*") || rules.includes(name);
}

/**
 * Gives an isolated group's Claude Code config the MCP servers you added globally (user scope,
 * `~/.claude.json` → `mcpServers`) that `rules` share, plus the local-scope servers of the
 * window's own workspace folders. Servers added in the group itself are kept; a shared one
 * with the same name follows the global definition. Re-run on every activation, so servers
 * added later appear after a reload. Writes only on a change, retrying when Claude Code
 * rewrites the file meanwhile.
 */
export function syncGroupMcp(globalFile: string, groupFile: string, rules: string[], folders: string[], log: (m: string) => void): void {
  const global = readConfig(globalFile);
  if (!global) {
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const mtime = fs.statSync(groupFile).mtimeMs;
      const config = readConfig(groupFile) ?? {};
      let changed = merge(config, "mcpServers", global.mcpServers, rules);
      for (const folder of folders) {
        const own = global.projects?.[folder]?.mcpServers;
        if (own && Object.keys(own).length) {
          config.projects ??= {};
          config.projects[folder] ??= {};
          changed = merge(config.projects[folder], "mcpServers", own, ["*"]) || changed;
        }
      }
      if (!changed) {
        return;
      }
      if (fs.statSync(groupFile).mtimeMs !== mtime) {
        continue; // Claude Code wrote it while we read: start over on the newer content
      }
      const tmp = `${groupFile}.agent-pool.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
      replaceFile(tmp, groupFile);
      return;
    } catch (e) {
      if (attempt === 4) {
        log(`Could not share MCP servers with the group: ${(e as Error).message}`);
      }
    }
  }
}

/** Copies the shared servers of `from` into `target[key]`; true when anything changed. */
function merge(target: Record<string, unknown>, key: string, from: Servers | undefined, rules: string[]): boolean {
  const current = { ...((target[key] as Servers | undefined) ?? {}) };
  let changed = false;
  for (const [name, def] of Object.entries(from ?? {})) {
    if (mcpShared(name, rules) && JSON.stringify(current[name]) !== JSON.stringify(def)) {
      current[name] = def;
      changed = true;
    }
  }
  if (changed) {
    target[key] = current;
  }
  return changed;
}

function readConfig(file: string): Config | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Config;
  } catch {
    return undefined;
  }
}
