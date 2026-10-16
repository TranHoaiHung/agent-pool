import * as vscode from "vscode";
import { AccountService } from "./account-service";
import { decide } from "./core/auto-switch-engine";
import { ordered } from "./core/priority";
import { AccountMeta, maxUsed, PROVIDER_LABEL, ProviderId, UsageRecord } from "./core/types";
import { HandoffController } from "./handoff/handoff-controller";
import { HttpError } from "./providers/http";

const TICK_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const ERROR_RETRY_MS = 60_000;
const MANUAL_HOLD_MS = 30 * 60_000;

/** Claude identity keys are `accountUuid:organizationUuid`. */
function orgOf(identityKey: string): string {
  return identityKey.split(":")[1] ?? "";
}

/** The auto switch threshold from settings, 50–100 (default 95). */
export function threshold(): number {
  const value = vscode.workspace.getConfiguration("agentPool").get<number>("autoSwitch.thresholdPercent") ?? 95;
  return Math.min(100, Math.max(50, Math.round(value)));
}

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
    private readonly isLeader: () => boolean,
    private readonly handoff?: HandoffController
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
    const isActive = this.service.activeId(account.provider) === account.id;
    if (!isActive) {
      // Idle accounts change only when used; auto switch reads them again when it needs them.
      return Math.max(10, cfg.get<number>("idlePollMinutes") ?? 30) * 60_000;
    }
    const base = account.provider === "claude"
      ? Math.max(180, cfg.get<number>("claude.pollIntervalSeconds") ?? 300)
      : Math.max(120, cfg.get<number>("codex.pollIntervalSeconds") ?? 300);
    const used = maxUsed(this.service.pool.get().usage[account.id]?.snapshot, Date.now()) ?? 0;
    // Watched closer within 10 points of the threshold, never more often than every 2 minutes.
    return (used >= threshold() - 10 ? Math.max(120, base / 2) : base) * 1000;
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

  /**
   * Switches the provider to the next account in priority order with room, right now (used
   * after a compaction near the limit). Leader only; respects pending reloads.
   */
  async switchNow(provider: ProviderId, why: string): Promise<void> {
    if (!this.isLeader() || this.service.pendingReload(provider)) {
      return;
    }
    const data = this.service.pool.get();
    const activeId = this.service.activeId(provider);
    const held = this.service.heldElsewhere(provider);
    const next = ordered(data, provider).find((a) => {
      const u = maxUsed(data.usage[a.id]?.snapshot, Date.now());
      return a.id !== activeId && a.id !== held && a.inRotation && !a.needsReauth && u !== undefined && u < threshold();
    });
    if (!next) {
      this.service.log(`[${provider}] ${why}, but no account with room to switch to`);
      return;
    }
    const from = this.service.account(activeId ?? "");
    try {
      const outcome = await this.service.switchTo(next.id, true, "threshold");
      this.onSwitched(provider, outcome.needsReload, `${PROVIDER_LABEL[provider]}: switched ${from?.label ?? "?"} → ${next.label} (${why}).`);
    } catch (e) {
      this.service.log(`[${provider}] switch after ${why} failed: ${(e as Error).message}`);
    }
  }

  private async autoSwitch(provider: ProviderId): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("agentPool");
    if (!cfg.get<boolean>("autoSwitch.enabled", true) || this.service.pendingReload(provider)) {
      return;
    }
    const data = this.service.pool.get();
    // The terminal's account (VS Code only mode) is not a candidate: it cannot be live twice.
    const held = this.service.heldElsewhere(provider);
    const accounts = ordered(data, provider).filter((a) => a.id !== held || a.id === this.service.activeId(provider));
    const active = accounts.find((a) => a.id === this.service.activeId(provider));
    const intervalMs = active ? this.interval(active) : 300_000;
    const last = data.lastSwitch[provider];
    if (provider === "claude" && active) {
      const usedNow = maxUsed(data.usage[active.id]?.snapshot, Date.now());
      // The account auto switch would go to: the first other one in priority order with room.
      const next = accounts.find((a) => {
        const u = maxUsed(data.usage[a.id]?.snapshot, Date.now());
        return a.id !== active.id && a.inRotation && !a.needsReauth && (u === undefined || u < threshold());
      });
      if (usedNow !== undefined) {
        this.handoff?.onActiveUsage(active.label, usedNow, threshold(), {
          exists: next !== undefined,
          crossOrg: next !== undefined && orgOf(next.identityKey) !== orgOf(active.identityKey),
        });
      }
    }
    const decision = decide({
      accounts,
      usage: data.usage,
      activeId: this.service.activeId(provider),
      thresholdPercent: threshold(),
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
    if (decision.action === "switch" && decision.reason === "threshold" && provider === "claude" && this.handoff?.shouldHoldSwitch(decision.usedPercent)) {
      this.service.log(`[claude] switch waits for the handoff (${decision.usedPercent}%)`);
      return;
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
