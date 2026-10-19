import * as vscode from "vscode";
import { AccountService } from "../account-service";
import { DEFAULT_GROUP, groupName, groupOf } from "../core/groups";
import { ordered } from "../core/priority";
import { AccountMeta, PROVIDER_LABEL, PROVIDERS, ProviderId } from "../core/types";
import { WindowGroup } from "../providers/claude/window-group";
import { SwitchOutcome } from "../providers/provider";
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
  const items = PROVIDERS.flatMap((p) =>
    service.ordered(p).map((a) => ({
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
  rerender: () => void,
  win?: WindowGroup
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
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Switching ${PROVIDER_LABEL[account.provider]} to ${account.label}…` },
      () => service.switchTo(account.id, false)
    );
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
    const items = service.ordered(provider).map((a, i) => ({
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

  reg("agentPool.useForTerminal", async (arg) => {
    const account =
      accountFrom(service, arg) ??
      (await pickAccount(service, "Pin which Claude Code account to the terminal?"));
    if (!account) return;
    const notes = await service.pinToTerminal(account.id);
    void vscode.window.showInformationMessage(
      [`Terminal pinned to ${account.label}: every \`claude\` you run there uses it. VS Code can use it too (kept in sync) and never moves the terminal off it.`, ...notes].join(" ")
    );
  });

  reg("agentPool.unpinTerminal", async () => {
    await service.unpinTerminal();
    void vscode.window.showInformationMessage("Terminal account unpinned.");
  });

  reg("agentPool.setThreshold", async () => {
    const cfg = vscode.workspace.getConfiguration("agentPool");
    const current = cfg.get<number>("autoSwitch.thresholdPercent") ?? 95;
    const value = await vscode.window.showInputBox({
      title: "Auto switch threshold",
      prompt: "Switch away when the 5-hour limit of the account in use reaches this share (50–100). Weekly limits have their own setting: agentPool.autoSwitch.weeklyThresholdPercent (default 98).",
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
    const last = service.pool.get().lastSwitch[service.lane(provider)];
    const back = last?.fromId && service.account(last.fromId);
    if (!back) {
      void vscode.window.showInformationMessage("Nothing to undo.");
      return;
    }
    const outcome = await service.switchTo(back.id, false);
    await reportOutcome(outcome, `${PROVIDER_LABEL[provider]} back to ${back.label}.`);
  });

  /** Lets the person choose a group, or create one; undefined when cancelled. */
  const pickGroup = async (placeHolder: string, current: string): Promise<string | undefined> => {
    const data = service.pool.get();
    const groups = [DEFAULT_GROUP, ...(data.groups ?? []).map((g) => g.id)];
    const items: Array<vscode.QuickPickItem & { id?: string }> = groups.map((id) => ({
      label: `${id === current ? "$(pass-filled)" : "$(circle-large-outline)"} ${groupName(data, id)}`,
      description: id === DEFAULT_GROUP ? "default: workspaces not assigned to a group" : undefined,
      id,
    }));
    items.push({ label: "$(add) New group…" });
    const pick = await vscode.window.showQuickPick(items, { placeHolder });
    if (!pick) {
      return undefined;
    }
    if (pick.id) {
      return pick.id;
    }
    const name = (await vscode.window.showInputBox({ prompt: "Name of the new account group", placeHolder: "Company" }))?.trim();
    if (!name) {
      return undefined;
    }
    const first = !(data.groups ?? []).length;
    const id = await service.createGroup(name);
    if (first) {
      void vscode.window.showInformationMessage(
        "AgentPool: account groups are on. Each VS Code window now gives Claude Code its own group's login. Reload the other open VS Code windows once."
      );
    }
    return id;
  };

  /** Moves accounts to `group` (or back to the default group), reporting the ones in use. */
  const moveAll = async (moves: Array<{ account: AccountMeta; to: string }>): Promise<number> => {
    const refused: string[] = [];
    let moved = 0;
    for (const { account, to } of moves) {
      try {
        await service.moveToGroup(account.id, to);
        moved++;
      } catch (e) {
        refused.push((e as Error).message);
      }
    }
    if (refused.length) {
      void vscode.window.showWarningMessage(`AgentPool: ${refused.join(" ")}`);
    }
    return moved;
  };

  /** Tick the Claude accounts a group has: ticked ones join it, unticked members go back to the default group. */
  const chooseMembers = async (group: string): Promise<void> => {
    const data = service.pool.get();
    const name = groupName(data, group);
    const items = ordered(data, "claude").map((a) => ({
      label: a.label,
      description: groupOf(a) === group ? undefined : `now in ${groupName(data, groupOf(a))}`,
      detail: [a.email, a.plan].filter(Boolean).join(" · ") || undefined,
      picked: groupOf(a) === group,
      account: a,
    }));
    if (!items.length) {
      return;
    }
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: `Claude Code accounts of the ${name} group`,
      placeHolder: group === DEFAULT_GROUP ? "Tick the accounts to bring back to Default" : `Tick the accounts that belong to ${name}; unticked ones go back to Default`,
    });
    if (!picks) {
      return;
    }
    const chosen = new Set(picks.map((p) => p.account.id));
    const moves = items
      .map((i) => i.account)
      .filter((a) => chosen.has(a.id) !== (groupOf(a) === group) && (chosen.has(a.id) || group !== DEFAULT_GROUP))
      .map((a) => ({ account: a, to: chosen.has(a.id) ? group : DEFAULT_GROUP }));
    const moved = await moveAll(moves);
    if (moved) {
      void vscode.window.showInformationMessage(`AgentPool: ${name} group updated (${moved} account${moved > 1 ? "s" : ""} moved).`);
    }
  };

  reg("agentPool.setWorkspaceGroup", async () => {
    if (!win?.workspaceKey) {
      void vscode.window.showInformationMessage("Open a folder or workspace first: account groups are assigned per workspace.");
      return;
    }
    const group = await pickGroup("Claude Code account group for this workspace", win.wanted());
    if (group === undefined) return;
    if (group !== DEFAULT_GROUP) {
      await chooseMembers(group); // pick the group's accounts in the same flow
    }
    const name = groupName(service.pool.get(), group);
    if (group === win.id) {
      await service.setWorkspaceGroup(win.workspaceKey, group);
      void vscode.window.showInformationMessage(`This workspace uses the ${name} group.`);
      return;
    }
    win.reloadAsked = true; // asked here, as a dialog: a toast is easy to miss
    await service.setWorkspaceGroup(win.workspaceKey, group);
    const choice = await vscode.window.showWarningMessage(
      `This workspace now uses the ${name} group.`,
      { modal: true, detail: `Reload the window: until then Claude Code here keeps the ${groupName(service.pool.get(), win.id)} group's account.` },
      "Reload Window"
    );
    if (choice === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  });

  reg("agentPool.editGroup", async (arg) => {
    // From the workspace row: that workspace's group, no question asked.
    const group = (arg as Node | undefined)?.kind === "workspace"
      ? win?.wanted() ?? service.group
      : await pickGroup("Choose the accounts of which group?", service.group);
    if (group !== undefined) await chooseMembers(group);
  });

  reg("agentPool.reloadWindow", () => Promise.resolve(vscode.commands.executeCommand("workbench.action.reloadWindow")));

  reg("agentPool.moveToGroup", async (arg, selection) => {
    // Several rows selected in the view (Cmd/Ctrl-click) are moved together.
    const fromTree = (Array.isArray(selection) ? selection : [arg]).map((n) => accountFrom(service, n)).filter((a): a is AccountMeta => !!a);
    const accounts = fromTree.length ? fromTree : [await pickAccount(service, "Move which Claude Code account to another group?")].filter((a): a is AccountMeta => !!a);
    const claude = accounts.filter((a) => a.provider === "claude");
    if (!claude.length) {
      if (accounts.length) void vscode.window.showInformationMessage("Only Claude Code accounts belong to groups.");
      return;
    }
    const names = claude.map((a) => a.label).join(", ");
    const group = await pickGroup(`Move ${names} to group…`, claude.length === 1 ? groupOf(claude[0]) : "");
    if (group === undefined) return;
    const moved = await moveAll(claude.map((account) => ({ account, to: group })));
    if (moved) {
      void vscode.window.showInformationMessage(
        `AgentPool: moved ${moved} account${moved > 1 ? "s" : ""} to the ${groupName(service.pool.get(), group)} group${group === service.group ? "" : " (shown in that group's windows)"}.`
      );
    }
  });
}
