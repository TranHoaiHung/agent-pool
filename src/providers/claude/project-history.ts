import * as fs from "fs";
import * as path from "path";
import { linkShared } from "../../core/fs-utils";

const MAX_NAME = 200;

/** Claude Code's folder name for a project under `projects/` (same rule as Claude Code). */
export function projectDirName(folder: string): string {
  const name = folder.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_NAME) {
    return name;
  }
  let hash = 0;
  for (let i = 0; i < folder.length; i++) {
    hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
  }
  return `${name.slice(0, MAX_NAME)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Makes an isolated group's slot see the conversation history of its own workspace folders
 * (and only those): `<slot>/projects/<name>` links to `~/.claude/projects/<name>`, so a
 * conversation started before the workspace joined the group can be continued, and history
 * stays in one place whichever group the workspace uses later. History the group already
 * wrote there is moved into the shared folder first; a file that exists on both sides stays.
 */
export function linkProjectHistory(sharedProjects: string, slotDir: string, folders: string[], log: (m: string) => void): void {
  const target = path.join(slotDir, "projects");
  fs.mkdirSync(target, { recursive: true });
  for (const name of new Set(folders.map(projectDirName))) {
    const source = path.join(sharedProjects, name);
    const link = path.join(target, name);
    try {
      if (isLink(link)) {
        continue;
      }
      fs.mkdirSync(source, { recursive: true });
      if (fs.existsSync(link)) {
        for (const entry of fs.readdirSync(link)) {
          if (!fs.existsSync(path.join(source, entry))) {
            fs.renameSync(path.join(link, entry), path.join(source, entry));
          }
        }
        if (fs.readdirSync(link).length > 0) {
          log(`Kept ${link}: some of its history also exists in ${source}.`);
          continue;
        }
        fs.rmdirSync(link);
      }
      linkShared(source, link);
    } catch (e) {
      log(`Could not link the history of ${name} into the group: ${(e as Error).message}`);
    }
  }
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
