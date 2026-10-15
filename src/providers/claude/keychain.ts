import { execFile, spawn } from "child_process";

/** Claude Code keeps its `security -i` command within this many bytes. */
const INTERACTIVE_LIMIT = 4032;
const TIMEOUT_MS = 5_000;

export class KeychainLockedError extends Error {
  constructor() {
    super("The macOS login keychain is locked. Unlock it and try again.");
  }
}

/** Reads a generic password; undefined when the item does not exist. */
export function readGenericPassword(account: string, service: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-a", account, "-w", "-s", service],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const code = (error as (Error & { code?: number }) | null)?.code;
        if (!error) {
          const text = stdout.trim();
          resolve(text ? text : undefined);
        } else if (code === 44) {
          resolve(undefined); // item not found
        } else if (code === 36) {
          reject(new KeychainLockedError()); // never read a locked keychain as empty
        } else {
          reject(new Error(`security find-generic-password failed: ${error.message}`));
        }
      }
    );
  });
}

/** Builds the `security -i` command Claude Code itself uses: value hex-encoded. */
export function addCommand(account: string, service: string, value: string): string {
  const hex = Buffer.from(value, "utf8").toString("hex");
  return `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -X ${hex}\n`;
}

/** Creates or replaces a generic password, the same way Claude Code writes its login. */
export async function writeGenericPassword(account: string, service: string, value: string): Promise<void> {
  const command = addCommand(account, service, value);
  if (Buffer.byteLength(command) <= INTERACTIVE_LIMIT) {
    await run("security", ["-i"], command);
  } else {
    const hex = Buffer.from(value, "utf8").toString("hex");
    await run("security", ["add-generic-password", "-U", "-a", account, "-s", service, "-X", hex]);
  }
}

export async function deleteGenericPassword(account: string, service: string): Promise<void> {
  await run("security", ["delete-generic-password", "-a", account, "-s", service]).catch((e: Error & { exitCode?: number }) => {
    if (e.exitCode !== 44) {
      throw e;
    }
  });
}

function quote(s: string): string {
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

function run(cmd: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`${cmd} ${args[0]} exited ${code}: ${stderr.trim()}`) as Error & { exitCode?: number };
        err.exitCode = code ?? undefined;
        if (code === 36) {
          reject(new KeychainLockedError());
        } else {
          reject(err);
        }
      }
    });
    child.stdin.end(stdin ?? "");
  });
}
