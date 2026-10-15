import * as vscode from "vscode";
import { AccountService } from "./account-service";
import { decide } from "./core/auto-switch-engine";
import { ordered } from "./core/priority";
import { AccountMeta, maxUsed, PROVIDER_LABEL, ProviderId, UsageRecord } from "./core/types";
import { HttpError } from "./providers/http";

const TICK_MS = 15_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const ERROR_RETRY_MS = 60_000;
const MANUAL_HOLD_MS = 30 * 60_000;

/**
 * Reads usage of every account on its provider's interval (the account in use more often
 * when it gets close), then lets auto switch decide. Runs only in the leader window.
 */
export class UsagePoller {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly service: AccountService,
    private readonly onSwitched: (provider: ProviderId, outcomeNeedsReload: boolean, message: string) => void,
    private readonly notify: (message: string) => void,
    private readonly isLeader: () => boolean
  ) {}

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      void this.tick();
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads every account now (manual refresh), ignoring intervals but not rate-limit holds. */
  async refreshAll(): Promise<void> {
    await this.service.refreshActive();
    const accounts = this.service.pool.get().accounts;
    await Promise.all(accounts.map((a) => this.read(a, true)));
  }

  private async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await this.service.refreshActive();
      for (const account of this.service.pool.get().accounts) {
        await this.read(account, false);
      }
      for (const provider of ["claude", "codex"] as ProviderId[]) {
        await this.autoSwitch(provider);
      }
    } catch (e) {
      this.service.log(`poll failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private interval(account: AccountMeta): number {
    const cfg = vscode.workspace.getConfiguration("agentPool");
    const base = account.provider === "claude"
      ? Math.max(180, cfg.get<number>("claude.pollIntervalSeconds") ?? 240)
      : Math.max(60, cfg.get<number>("codex.pollIntervalSeconds") ?? 120);
    const isActive = this.service.activeId(account.provider) === account.id;
    const used = maxUsed(this.service.pool.get().usage[account.id]?.snapshot, Date.now()) ?? 0;
    // The account in use is watched closer as it nears the threshold, never below 90s.
    return (isActive && used >= 80 ? Math.max(90, base / 2) : base) * 1000;
  }

  private async read(account: AccountMeta, force: boolean): Promise<void> {
    const record: UsageRecord = this.service.pool.get().usage[account.id] ?? {};
    const now = Date.now();
    if (record.holdUntil && now < record.holdUntil) {
      return;
    }
    const last = Math.max(record.snapshot?.fetchedAt ?? 0, record.errorAt ?? 0);
    const wait = record.error && !record.snapshot ? ERROR_RETRY_MS : this.interval(account);
    if ((!force && now - last < wait) || this.inFlight.has(account.id)) {
      return;
    }
    this.inFlight.add(account.id);
    try {
      const snapshot = await this.service.providers.get(account.provider)!.usage(account);
      await this.service.pool.mutate((data) => {
        data.usage[account.id] = { snapshot };
        const meta = data.accounts.find((a) => a.id === account.id);
        if (meta) {
          meta.needsReauth = false;
          meta.plan = snapshot.plan ?? meta.plan;
        }
      });
    } catch (e) {
      const err = e as Error;
      const http = err instanceof HttpError ? err : undefined;
      await this.service.pool.mutate((data) => {
        const prev = data.usage[account.id] ?? {};
        data.usage[account.id] = {
          ...prev,
          error: err.message,
          errorAt: Date.now(),
          holdUntil: http?.rateLimited ? Date.now() + (http.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS) : undefined,
        };
        const meta = data.accounts.find((a) => a.id === account.id);
        if (meta && http?.deadLogin) {
          meta.needsReauth = true;
        }
      });
      this.service.log(`[${account.provider}] usage of ${account.label}: ${err.message}`);
    } finally {
      this.inFlight.delete(account.id);
    }
  }

  private async autoSwitch(provider: ProviderId): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("agentPool");
    if (!cfg.get<boolean>("autoSwitch.enabled", true) || this.service.pendingReload(provider)) {
      return;
    }
    const data = this.service.pool.get();
    const accounts = ordered(data, provider);
    const intervalMs = accounts[0] ? this.interval(accounts[0]) : 240_000;
    const last = data.lastSwitch[provider];
    const decision = decide({
      accounts,
      usage: data.usage,
      activeId: this.service.activeId(provider),
      thresholdPercent: Math.min(99, Math.max(50, cfg.get<number>("autoSwitch.thresholdPercent") ?? 95)),
      // Going back only undoes AgentPool's own move off a higher-priority account that was
      // full. Saving an account, or a manual switch, never triggers it.
      returnToPreferred:
        cfg.get<boolean>("autoSwitch.returnToPreferred", true) && last?.automatic === true && last.reason === "threshold",
      maxAgeMs: intervalMs * 3,
      now: Date.now(),
      // An automatic switch: the account switched to is read once before anything switches
      // away from it again. A manual one (or Undo) is the person's choice: left alone longer.
      quietUntil: last ? last.at + (last.automatic ? intervalMs : MANUAL_HOLD_MS) : undefined,
    });

    if (decision.action === "refresh") {
      for (const id of decision.ids) {
        const account = this.service.account(id);
        if (account) {
          await this.read(account, true);
        }
      }
      return; // decided again on the next tick, with the new readings
    }
    if (decision.action === "switch" && !this.isLeader()) {
      return; // leadership moved while reading usage
    }
    if (decision.action === "switch") {
      const from = this.service.account(this.service.activeId(provider) ?? "");
      const to = this.service.account(decision.toId)!;
      try {
        const outcome = await this.service.switchTo(decision.toId, true, decision.reason);
        const why = decision.reason === "threshold" ? `${from?.label ?? "?"} reached ${decision.usedPercent}%` : `${to.label} has room again`;
        this.onSwitched(provider, outcome.needsReload, `${PROVIDER_LABEL[provider]}: switched ${from?.label ?? "?"} → ${to.label} (${why}).`);
      } catch (e) {
        this.service.log(`[${provider}] auto switch failed: ${(e as Error).message}`);
      }
    } else if (decision.action === "exhausted" && data.noticeKeys[provider] !== decision.noticeKey) {
      await this.service.pool.mutate((d) => {
        d.noticeKeys[provider] = decision.noticeKey;
      });
      const when = decision.soonestReset ? new Date(decision.soonestReset).toLocaleTimeString() : "unknown";
      this.notify(`${PROVIDER_LABEL[provider]}: every account in rotation is at the limit. Soonest reset: ${when}.`);
    }
  }
}
