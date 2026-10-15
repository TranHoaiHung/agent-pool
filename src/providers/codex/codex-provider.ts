import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { poolHome } from "../../core/pool-store";
import { AccountMeta, CodexAuth, UsageSnapshot } from "../../core/types";
import { withLocks } from "../../core/dir-lock";
import { fingerprint } from "../../core/secret-vault";
import { accountsOf, lockAccount, Place, Provider, ProviderContext, SwitchOutcome, waitFor } from "../provider";
import { codexIdentity, fetchCodexUsage, isCodexTokenExpiring, refreshCodex } from "./codex-api";
import { authFile, codexHome, configuredStore, findCodexBinary } from "./codex-paths";

/**
 * Codex accounts: one login in `$CODEX_HOME/auth.json`. A running Codex keeps its login in
 * memory for the life of the process, so a switch needs Codex restarted. Never runs
 * `codex logout`: it revokes the refresh token, which would kill the parked login.
 */
export class CodexProvider implements Provider {
  readonly id = "codex" as const;

  constructor(private readonly ctx: ProviderContext) {}

  invalidate(): void {
    /* identification is local and cheap; nothing cached */
  }

  async activeAccountId(): Promise<string | undefined> {
    const auth = readAuth();
    return auth ? this.match(auth) : undefined;
  }

  async places(): Promise<Place[]> {
    const auth = readAuth();
    return [{ label: "Codex", accountId: auth ? this.match(auth) : undefined, email: auth ? codexIdentity(auth)?.email : undefined }];
  }

  async captureCurrent() {
    const auth = readAuth();
    const identity = auth && identityFor(auth);
    if (!auth || !identity) {
      return undefined;
    }
    return { secret: { kind: "codex" as const, auth }, identity };
  }

  async usage(account: AccountMeta): Promise<UsageSnapshot> {
    const live = readAuth();
    if (live && this.match(live) === account.id) {
      // Codex owns the live login and renews it without any lock: only read it.
      await this.sync(account.id, live);
      return fetchCodexUsage(live);
    }
    const auth = await this.freshParked(account);
    return fetchCodexUsage(auth);
  }

  async switchTo(account: AccountMeta): Promise<SwitchOutcome> {
    assertFileStore();
    const current = readAuth();
    if (current && this.match(current) === account.id) {
      return { needsReload: false, notes: [] }; // already in use: never write a vault copy over it
    }
    const incoming = await this.freshParked(account);

    // Codex has no lock of its own; this one keeps two VS Code windows from switching at once.
    const lock = { path: path.join(poolHome(), "codex-switch.lock"), staleMs: 30_000, heartbeatMs: 5_000 };
    let wrote = false;
    await withLocks([lock], 20_000, async () => {
      // Re-read right before writing: park exactly what is about to be replaced.
      const outgoing = readAuthStrict();
      if (outgoing && JSON.stringify(outgoing) !== "{}") {
        const ownerId = this.match(outgoing);
        if (ownerId === account.id) {
          return;
        }
        if (ownerId) {
          await this.sync(ownerId, outgoing);
        } else {
          const identity = identityFor(outgoing) ?? {
            identityKey: `unknown:${fingerprint(JSON.stringify(outgoing))}`,
            email: "unidentified Codex login",
          };
          const meta = await this.ctx.enroll("codex", { kind: "codex", auth: outgoing }, identity);
          this.ctx.log(`Saved the outgoing Codex login as "${meta.label}" before switching.`);
        }
      }
      writeAuth(incoming);
      wrote = true;
    });
    return {
      needsReload: wrote,
      notes: wrote ? ["Running Codex sessions keep the old account until restarted (reload the window; restart `codex` in terminals)."] : [],
    };
  }

  async login(cancel: { isCancellationRequested: boolean }) {
    const binary = findCodexBinary(vscode.workspace.getConfiguration("agentPool").get<string>("codexCommand"));
    if (!binary) {
      throw new Error("Codex CLI not found. Install it or set agentPool.codexCommand.");
    }
    const home = path.join(poolHome(), `codex-login-${Date.now()}`);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const terminal = vscode.window.createTerminal({ name: "AgentPool: Codex login", cwd: home, env: { CODEX_HOME: home } });
    terminal.show();
    // `-c` before `login` forces the file store over any config layer the person has.
    terminal.sendText(`${shellQuote(binary)} -c cli_auth_credentials_store="file" login`);
    try {
      const auth = await waitFor(async () => {
        const a = readAuth(home);
        return a?.tokens?.refresh_token ? a : undefined;
      }, cancel, 10 * 60_000);
      const identity = codexIdentity(auth);
      if (!identity) {
        throw new Error("Could not identify the Codex login.");
      }
      return { secret: { kind: "codex" as const, auth }, identity };
    } finally {
      terminal.dispose();
      fs.rmSync(home, { recursive: true, force: true }); // parked now; no logout (it revokes)
    }
  }

  private match(auth: CodexAuth): string | undefined {
    const key = identityFor(auth)?.identityKey;
    return key ? accountsOf(this.ctx, "codex").find((a) => a.identityKey === key)?.id : undefined;
  }

  /** Stores a newer generation of a saved account's login, never an older one. */
  private async sync(accountId: string, auth: CodexAuth): Promise<void> {
    const stored = await this.ctx.vault.get(accountId);
    if (stored?.kind === "codex") {
      if (JSON.stringify(stored.auth) === JSON.stringify(auth)) {
        return;
      }
      if (Date.parse(stored.auth.last_refresh ?? "") > Date.parse(auth.last_refresh ?? "")) {
        return;
      }
    }
    await this.ctx.vault.set(accountId, { kind: "codex", auth });
  }

  /** The account's parked login, renewed under its cross-window lock when expiring. */
  private freshParked(account: AccountMeta): Promise<CodexAuth> {
    return lockAccount(account.id, async () => {
      const secret = await this.ctx.vault.get(account.id);
      if (secret?.kind !== "codex") {
        throw new Error(`No saved login for ${account.label}. Sign in to it again.`);
      }
      if (!isCodexTokenExpiring(secret.auth)) {
        return secret.auth;
      }
      const renewed = await refreshCodex(secret.auth);
      await this.ctx.vault.set(account.id, { kind: "codex", auth: renewed });
      return renewed;
    });
  }
}

function assertFileStore(): void {
  const store = configuredStore();
  if (store !== "file") {
    throw new Error(
      `Codex is configured with cli_auth_credentials_store = "${store}". AgentPool only switches the "file" store (auth.json).`
    );
  }
}

function readAuth(home = codexHome()): CodexAuth | undefined {
  try {
    return JSON.parse(fs.readFileSync(authFile(home), "utf8")) as CodexAuth;
  } catch {
    return undefined;
  }
}

/** ChatGPT logins by their ID token; API-key logins by a fingerprint of the key. */
function identityFor(auth: CodexAuth) {
  return codexIdentity(auth) ??
    (auth.OPENAI_API_KEY ? { identityKey: `apikey:${fingerprint(auth.OPENAI_API_KEY)}`, email: "Codex API-key login" } : undefined);
}

/** Like readAuth, but a file that exists and cannot be parsed stops the switch. */
function readAuthStrict(): CodexAuth | undefined {
  const file = authFile();
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CodexAuth;
  } catch (e) {
    throw new Error(`Cannot read ${file} (${(e as Error).message}); not overwriting it.`);
  }
}

function writeAuth(auth: CodexAuth): void {
  const file = authFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.agent-pool.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
