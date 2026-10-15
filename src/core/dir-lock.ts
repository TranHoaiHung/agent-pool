import * as fs from "fs";
import * as path from "path";

/**
 * Directory locks compatible with proper-lockfile, which Claude Code uses: a lock is a
 * directory created atomically with mkdir; its holder touches the mtime as a heartbeat,
 * and a lock untouched past its staleness can be taken over.
 */
export interface LockSpec {
  /** The lock directory itself, e.g. `<dir>/.storage-write.lock`. */
  path: string;
  staleMs: number;
  heartbeatMs: number;
}

export class LockBusyError extends Error {
  constructor(lock: string) {
    super(`Lock is busy: ${lock}`);
  }
}

/** Claude Code's write lock around every write of its login. */
export function writeLock(storageDir: string): LockSpec {
  return { path: path.join(storageDir, ".storage-write.lock"), staleMs: 15_000, heartbeatMs: 7_500 };
}

/** Claude Code's refresh locks: `.oauth_refresh.lock` plus the legacy `<realdir>.lock`. */
export function refreshLocks(storageDir: string): LockSpec[] {
  let real = storageDir;
  try {
    real = fs.realpathSync(storageDir);
  } catch {
    /* proper-lockfile falls back to the given path too */
  }
  return [
    { path: path.join(storageDir, ".oauth_refresh.lock"), staleMs: 60_000, heartbeatMs: 5_000 },
    { path: `${real}.lock`, staleMs: 60_000, heartbeatMs: 5_000 },
  ];
}

/**
 * Runs `action` holding every lock, taken in the given order. Never waits while holding a
 * partial set, so it cannot deadlock with a process taking the same locks.
 */
export async function withLocks<T>(
  locks: LockSpec[],
  timeoutMs: number,
  action: () => Promise<T>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const held: LockSpec[] = [];
  const releaseAll = () => {
    while (held.length > 0) {
      const lock = held.pop()!;
      fs.rmSync(lock.path, { recursive: true, force: true });
    }
  };

  let delay = 100;
  for (;;) {
    let busy: LockSpec | undefined;
    for (const lock of locks) {
      if (tryAcquire(lock)) {
        held.push(lock);
      } else {
        busy = lock;
        break;
      }
    }
    if (!busy) {
      break;
    }
    releaseAll();
    if (Date.now() >= deadline) {
      throw new LockBusyError(busy.path);
    }
    await sleep(delay + Math.random() * 100);
    delay = Math.min(delay * 2, 1_000);
  }

  const beat = setInterval(() => {
    const now = new Date();
    for (const lock of held) {
      try {
        fs.utimesSync(lock.path, now, now);
      } catch {
        /* removed underneath us; the re-read under lock still protects the write */
      }
    }
  }, Math.min(...held.map((l) => l.heartbeatMs)));

  try {
    return await action();
  } finally {
    clearInterval(beat);
    releaseAll();
  }
}

function tryAcquire(lock: LockSpec): boolean {
  fs.mkdirSync(path.dirname(lock.path), { recursive: true });
  try {
    fs.mkdirSync(lock.path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }
  try {
    if (Date.now() - fs.statSync(lock.path).mtimeMs > lock.staleMs) {
      // Rename aside first: only one process can win the rename, so two that both judged
      // the lock stale cannot both end up holding it.
      const aside = `${lock.path}.stale-${process.pid}-${Date.now()}`;
      fs.renameSync(lock.path, aside);
      fs.rmSync(aside, { recursive: true, force: true });
      fs.mkdirSync(lock.path);
      return true;
    }
  } catch {
    /* lost the race for a stale lock: retry later */
  }
  return false;
}

/**
 * Serialises work on one parked login across every VS Code window, so a single-use
 * refresh token is never spent twice (two windows renewing the same account at once).
 */
export function withAccountLock<T>(lockDir: string, accountId: string, action: () => Promise<T>): Promise<T> {
  const lock = { path: path.join(lockDir, `${accountId}.lock`), staleMs: 60_000, heartbeatMs: 5_000 };
  return withLocks([lock], 30_000, action);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
