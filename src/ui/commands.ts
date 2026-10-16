import * as vscode from "vscode";
import { AccountService } from "../account-service";
import { ordered } from "../core/priority";
import { AccountMeta, PROVIDER_LABEL, PROVIDERS, ProviderId } from "../core/types";
import { HeldElsewhereError, SwitchOptions, SwitchOutcome } from "../providers/provider";
import { UsagePoller } from "../usage-poller";
import { Node } from "./accounts-tree";
import { compactUsage } from "./format";
import { showQuickView } from "./quick-view";

/** The order is stored the moment it changes; this only says so. */
export function prioritySaved(): void {
  vscode.window.setStatusBarMessage("$(check) AgentPool: priority order saved", 2500);
}

/** Accepts a tree node, an account id (tooltip links) or nothing. */
function accountFrom(service: AccountService, arg: unknown): AccountMeta | undefined {
  if (typeof arg === "string") {
    return service.account(arg);
  }
  const node = arg as Node | undefined;
  return node?.kind === "account" ? service.account(node.account.id) : undefined;
}

/** Lets the person choose one saved account of any tool. */
async function pickAccount(service: AccountService, placeHolder: string): Promise<AccountMeta | undefined> {
  const data = service.pool.get();
  const items = PROVIDERS.flatMap((p) =>
    ordered(data, p).map((a) => ({
      label: a.label,
      description: `${PROVIDER_LABEL[p]}${service.activeId(p) === a.id ? " · in use" : ""}`,
      detail: a.email,
      account: a,
    }))
  );
  if (items.length === 0) {
    void vscode.window.showInformationMessage("No saved accounts.");
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.account;
}

async function pickProvider(arg: unknown, placeHolder: string): Promise<ProviderId | undefined> {
  if (arg === "claude" || arg === "codex") {
    return arg;
  }
  const pick = await vscode.window.showQuickPick(
    PROVIDERS.map((p) => ({ label: PROVIDER_LABEL[p], id: p })),
    { placeHolder }
  );
  return pick?.id;
}

export async function reportOutcome(outcome: SwitchOutcome, message: string, provider?: ProviderId): Promise<void> {
  const autoReload = vscode.workspace.getConfiguration("agentPool").get<boolean>("autoReloadAfterSwitch");
  if (outcome.needsReload && autoReload) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
    return;
  }
  if (outcome.mustReload) {
    // Until this reload Claude Code keeps spending the previous account: not a toast to miss.
    const choice = await vscode.window.showWarningMessage(
      [message, ...outcome.notes].join(" "),
      { modal: true, detail: "Claude Code in this window keeps using the previous account until the window reloads." },
      "Reload Window"
    );
    if (choice === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    return;
  }
  const actions = outcome.needsReload ? ["Reload Window"] : [];
  if (provider) {
    actions.push("Undo");
  }
  const text = [message, ...outcome.notes].join(" ");
  const choice = await vscode.window.showInformationMessage(text, ...actions);
  if (choice === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } else if (choice === "Undo" && provider) {
    await vscode.commands.executeCommand("agentPool.undo", provider);
  }
}

export function registerCommands(
  context: vscode.ExtensionContext,
  service: AccountService,
  poller: () => UsagePoller | undefined,
  rerender: () => void
): void {
  const run = (fn: (...args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
    try {
      await fn(...args);
    } catch (e) {
      void vscode.window.showErrorMessage(`AgentPool: ${(e as Error).message}`);
      service.log(`error: ${(e as Error).stack ?? e}`);
    } finally {
      rerender();
    }
  };

  const doSwitch = async (account: AccountMeta) => {
    const run = (options?: SwitchOptions) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Switching ${PROVIDER_LABEL[account.provider]} to ${account.label}…` },
        () => service.switchTo(account.id, false, undefined, options)
      );
    let outcome: SwitchOutcome;
    try {
      outcome = await run();
    } catch (e) {
      if (!(e instanceof HeldElsewhereError)) {
        throw e;
      }
      const swap = await vscode.window.showWarningMessage(
        `${account.label} is in use by the ${e.where}. One login cannot run in two places at once.`,
        { modal: true, detail: `Swap: VS Code takes ${account.label} and the ${e.where} takes the account VS Code uses now. Or turn on "Switch terminal too" to move both together.` },
        "Swap"
      );
      if (swap !== "Swap") {
        return;
      }
      outcome = await run({ swapWithTerminal: true });
    }
    await reportOutcome(outcome, `${PROVIDER_LABEL[account.provider]} → ${account.label}.`, account.provider);
  };

  const reg = (id: string, fn: (...args: unknown[]) => Promise<unknown>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, run(fn)));

  reg("agentPool.quickView", () => showQuickView(service, doSwitch));

  reg("agentPool.saveCurrent", async (arg) => {
    const provider = await pickProvider(arg, "Save the login currently used by…");
    if (!provider) return;
    const meta = await service.saveCurrent(provider);
    void vscode.window.showInformationMessage(
      meta
        ? `Saved ${PROVIDER_LABEL[provider]} account "${meta.label}".`
        : `No ${PROVIDER_LABEL[provider]} login found. Sign in to ${PROVIDER_LABEL[provider]} first${
            provider === "claude" && process.platform === "win32"
              ? " (on Windows AgentPool reads %USERPROFILE%\\.claude\\.credentials.json)"
              : ""
          }.`
    );
    void poller()?.refreshAll();
  });

  reg("agentPool.addAccount", async (arg) => {
    const provider = await pickProvider(arg, "Sign in to another account of…");
    if (!provider) return;
    const meta = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Complete the ${PROVIDER_LABEL[provider]} sign-in in the terminal/browser (your current login is untouched)…`,
        cancellable: true,
      },
      (_p, token) => service.addAccount(provider, token)
    );
    void vscode.window.showInformationMessage(`Added ${PROVIDER_LABEL[provider]} account "${meta.label}".`);
    void poller()?.refreshAll();
  });

  reg("agentPool.switch", async (arg) => {
    const provider = await pickProvider(arg, "Switch account of…");
    if (!provider) return;
    const data = service.pool.get();
    const activeId = service.activeId(provider);
    const items = ordered(data, provider).map((a, i) => ({
      label: `${a.id === activeId ? "$(pass-filled)" : "$(circle-large-outline)"} ${i + 1}. ${a.label}`,
      description: a.needsReauth ? "needs sign-in" : compactUsage(data.usage[a.id]),
      detail: [a.email, a.plan].filter(Boolean).join(" · ") || undefined,
      account: a,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `${PROVIDER_LABEL[provider]}: choose the account to use` });
    if (pick && pick.account.id !== activeId) {
      await doSwitch(pick.account);
    }
  });

  reg("agentPool.switchTo", async (arg) => {
    const account = accountFrom(service, arg);
    if (account) await doSwitch(account);
  });

  reg("agentPool.refresh", async () => {
    const p = poller();
    if (!p) {
      void vscode.window.showInformationMessage("Usage is read by another VS Code window (the leader).");
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "AgentPool: reading usage" }, () => p.refreshAll());
  });

  reg("agentPool.rename", async (arg) => {
    const account = accountFrom(service, arg);
    if (!account) return;
    const label = await vscode.window.showInputBox({ value: account.label, prompt: "Account name" });
    if (label?.trim()) await service.update(account.id, (a) => (a.label = label.trim()));
  });

  reg("agentPool.remove", async (arg) => {
    const account = accountFrom(service, arg) ?? (await pickAccount(service, "Remove which account from AgentPool?"));
    if (!account) return;
    const live = service.activeId(account.provider) === account.id;
    const ok = await vscode.window.showWarningMessage(
      `Remove "${account.label}" from AgentPool?${live ? " It stays signed in where it is in use." : " Its saved login is deleted."}`,
      { modal: true },
      "Remove"
    );
    if (ok === "Remove") await service.remove(account.id);
  });

  reg("agentPool.moveUp", async (arg) => {
    const account = accountFrom(service, arg);
    if (account) {
      await service.move(account.id, -1);
      prioritySaved();
    }
  });

  reg("agentPool.moveDown", async (arg) => {
    const account = accountFrom(service, arg);
    if (account) {
      await service.move(account.id, 1);
      prioritySaved();
    }
  });

  reg("agentPool.toggleRotation", async (arg) => {
    const account = accountFrom(service, arg);
    if (account) await service.update(account.id, (a) => (a.inRotation = !a.inRotation));
  });

  reg("agentPool.setThreshold", async () => {
    const cfg = vscode.workspace.getConfiguration("agentPool");
    const current = cfg.get<number>("autoSwitch.thresholdPercent") ?? 95;
    const value = await vscode.window.showInputBox({
      title: "Auto switch threshold",
      prompt: "Switch away when the 5-hour limit of the account in use reaches this share (50–100). Weekly limits use their own threshold (setting agentPool.autoSwitch.weeklyThresholdPercent, default 95).",
      value: String(current),
      validateInput: (v) => (/^\d+$/.test(v.trim()) && +v >= 50 && +v <= 100 ? undefined : "Enter a whole number from 50 to 100"),
    });
    if (value === undefined) return;
    await cfg.update("autoSwitch.thresholdPercent", Number(value), vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`AgentPool switches at ${Number(value)}%.`);
  });

  reg("agentPool.toggleAutoSwitch", async () => {
    const cfg = vscode.workspace.getConfiguration("agentPool");
    const next = !cfg.get<boolean>("autoSwitch.enabled", true);
    await cfg.update("autoSwitch.enabled", next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`AgentPool auto switch ${next ? "on" : "off"}.`);
  });

  reg("agentPool.toggleTerminalScope", async () => {
    const cfg = vscode.workspace.getConfiguration("agentPool");
    const next = !cfg.get<boolean>("claude.switchTerminalToo", false);
    await cfg.update("claude.switchTerminalToo", next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      next
        ? "Claude Code: switches now move the terminal's `claude` too (system Keychain). Applies from the next switch."
        : "Claude Code: switches now move only Claude Code inside VS Code. Applies from the next switch."
    );
  });

  reg("agentPool.undo", async (arg) => {
    const provider = await pickProvider(arg, "Undo the last switch of…");
    if (!provider) return;
    const last = service.pool.get().lastSwitch[provider];
    const back = last?.fromId && service.account(last.fromId);
    if (!back) {
      void vscode.window.showInformationMessage("Nothing to undo.");
      return;
    }
    const outcome = await service.switchTo(back.id, false);
    await reportOutcome(outcome, `${PROVIDER_LABEL[provider]} back to ${back.label}.`);
  });
}
