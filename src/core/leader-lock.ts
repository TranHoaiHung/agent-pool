import * as fs from "fs";
import { replaceFile } from "./fs-utils";
import * as path from "path";
import { withLocks } from "./dir-lock";
import { poolHome } from "./pool-store";

const STALE_MS = 30_000;
const BEAT_MS = 10_000;

/**
 * Elects one VS Code window as leader. Only the leader polls usage and switches by itself,
 * so several open windows neither multiply rate-limited usage calls nor switch twice.
 */
export class LeaderLock {
  private readonly file = path.join(poolHome(), "leader.json");
  private readonly id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private timer?: NodeJS.Timeout;
  private leader = false;

  constructor(private readonly onChange: (isLeader: boolean) => void) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), BEAT_MS);
  }

  isLeader(): boolean {
    return this.leader;
  }

  dispose(): void {
    clearInterval(this.timer);
    if (this.leader) {
      try {
        const current = JSON.parse(fs.readFileSync(this.file, "utf8")) as { id?: string };
        if (current.id === this.id) {
          fs.rmSync(this.file, { force: true });
        }
      } catch {
        /* nothing to release */
      }
    }
  }

  /** Read-decide-write under a lock, so two windows can never both claim leadership. */
  private async tick(): Promise<void> {
    const lock = { path: `${this.file}.lock`, staleMs: 5_000, heartbeatMs: 2_000 };
    let leader = false;
    try {
      leader = await withLocks([lock], 2_000, async () => {
        let current: { id?: string; at?: number } = {};
        try {
          current = JSON.parse(fs.readFileSync(this.file, "utf8"));
        } catch {
          /* no leader yet */
        }
        const free = !current.id || !current.at || Date.now() - current.at > STALE_MS;
        if (!free && current.id !== this.id) {
          return false;
        }
        const tmp = `${this.file}.${this.id}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ id: this.id, at: Date.now() }));
        replaceFile(tmp, this.file);
        return true;
      });
    } catch {
      leader = false; // could not even take the lock: let another window lead this round
    }
    if (leader !== this.leader) {
      this.leader = leader;
      this.onChange(leader);
    }
  }
}
