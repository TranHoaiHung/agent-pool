import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { withLocks } from "./dir-lock";
import { emptyPool, PoolData } from "./types";

/** AgentPool's own folder: shared state, the VS Code slot and temporary logins. */
export function poolHome(): string {
  return process.env.AGENT_POOL_HOME || path.join(os.homedir(), ".agent-pool");
}

/**
 * Non-secret pool state in one JSON file shared by every VS Code window, so all windows
 * see the same accounts, order and usage. Writes are read-modify-write under a lock and
 * land through rename, so a reader never sees half a file.
 */
export class PoolStore {
  private data: PoolData = emptyPool();
  private watcher?: fs.FSWatcher;
  private listeners: Array<() => void> = [];
  private lastText = "";

  constructor(private readonly file = path.join(poolHome(), "pool.json")) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.reload();
  }

  get(): PoolData {
    return this.data;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Applies `change` to the newest state on disk and saves it. */
  async mutate(change: (data: PoolData) => void): Promise<PoolData> {
    const lock = { path: `${this.file}.lock`, staleMs: 10_000, heartbeatMs: 3_000 };
    await withLocks([lock], 10_000, async () => {
      this.reload(false);
      change(this.data);
      const text = JSON.stringify(this.data, null, 2);
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.lastText = text;
    });
    this.emit();
    return this.data;
  }

  /** Watches the file for writes made by other windows. */
  watch(): void {
    if (this.watcher) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    this.watcher = fs.watch(path.dirname(this.file), (_event, name) => {
      if (name !== path.basename(this.file)) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          this.reload();
        } catch {
          /* transient read error: the next change event reloads */
        }
      }, 150);
    });
  }

  dispose(): void {
    this.watcher?.close();
  }

  private reload(notify = true): void {
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e; // never treat an unreadable file as an empty pool (a save would wipe it)
      }
    }
    if (text === this.lastText && notify) {
      return;
    }
    const parsed = parse(text);
    if (!parsed) {
      // Corrupt: keep it for inspection and go on with the last good state.
      fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      return;
    }
    this.lastText = text;
    this.data = parsed;
    if (notify) {
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function parse(text: string): PoolData | undefined {
  if (!text) {
    return emptyPool();
  }
  try {
    const raw = JSON.parse(text) as Partial<PoolData>;
    const base = emptyPool();
    return {
      ...base,
      ...raw,
      order: { ...base.order, ...(raw.order ?? {}) },
      usage: raw.usage ?? {},
      lastSwitch: raw.lastSwitch ?? {},
      noticeKeys: raw.noticeKeys ?? {},
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    };
  } catch {
    return undefined;
  }
}
