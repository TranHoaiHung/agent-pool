import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AccountService } from "./account-service";
import { LeaderLock } from "./core/leader-lock";
import { HandoffController } from "./handoff/handoff-controller";
import { groupName } from "./core/groups";
import { poolHome, PoolStore } from "./core/pool-store";
import { VsSecretVault } from "./core/secret-vault";
import { ClaudeProvider } from "./providers/claude/claude-provider";
import { VscodeScope } from "./providers/claude/vscode-scope";
import { WindowGroup } from "./providers/claude/window-group";
import { CodexProvider } from "./providers/codex/codex-provider";
import { AccountsTree } from "./ui/accounts-tree";
import { registerCommands, reportOutcome } from "./ui/commands";
import { onboard } from "./ui/onboarding";
import { RatingPrompt } from "./ui/rating-prompt";
import { StatusBar } from "./ui/status-bar";
import { UsagePoller } from "./usage-poller";

const FOLLOWER_REFRESH_MS = 60_000;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("AgentPool");
  const log = (m: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);

  const pool = new PoolStore();
  // This window's account group, applied before anything else: Claude Code passes this
  // extension host's CLAUDE_CONFIG_DIR on to every session it starts.
  const win = new WindowGroup(pool, workspaceKey());
  const scope = new VscodeScope(log, win, context.environmentVariableCollection);
  void scope.apply().catch((e: Error) => log(`account group setup: ${e.message}`));
  const service = new AccountService(pool, new VsSecretVault(context.secrets), log);
  service.group = win.id;
  service.wantedGroup = () => win.wanted();
  if (win.on() && !win.isDefault() && vscode.extensions.getExtension("anthropic.claude-code")?.isActive) {
    // Claude Code started first: sessions it already opened may run the global login.
    void vscode.window
      .showWarningMessage(
        `AgentPool: Claude Code started before AgentPool in this window, so it may not use the "${win.name()}" group's account yet. Reload the window to be sure.`,
        "Reload Window"
      )
      .then((c) => c && vscode.commands.executeCommand("workbench.action.reloadWindow"));
  }
  service.register(new ClaudeProvider(service.providerContext(), scope));
  service.register(new CodexProvider(service.providerContext()));
  removeStaleLogins(log);
  // Claude Code in this window was started with the slot setting as it is now; it needs a
  // reload only when that setting changes afterwards (not because of switches in other windows).
  const dirAtStart = scope.effectiveDir();
  service.setReloadCheck("claude", () => win.wanted() !== win.id || scope.effectiveDir() !== dirAtStart);
  if (scope.isActive()) {
    scope.prepareFolder(); // pick up shared items added since
  }

  const statusBar = new StatusBar(service);
  const tree = new AccountsTree(service, win.workspaceKey);
  const view = vscode.window.createTreeView("agentPool.accounts", {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true, // several accounts can be moved to a group at once
  });
  const version = String(context.extension.packageJSON.version ?? "");
  view.description = win.on() ? `${win.name()} · v${version}` : `v${version}`;
  log(`AgentPool v${version} on ${process.platform} (VS Code ${vscode.version})${win.on() ? `, account group ${win.name()}` : ""}`);
  statusBar.version = version;
  service.settings = { autoSaveLogins: () => vscode.workspace.getConfiguration("agentPool").get<boolean>("autoSaveLogins", true) };
  service.onAutoSaved((meta) => {
    void vscode.window.showInformationMessage(
      `AgentPool saved the ${meta.provider === "claude" ? "Claude Code" : "Codex"} account you signed in to: ${meta.email ?? meta.label}.`
    );
  });
  const rerender = () => {
    statusBar.render();
    tree.refresh();
    // Shows the reload button in the view's title bar only while it is needed.
    void vscode.commands.executeCommand("setContext", "agentPool.reloadPending", service.pendingReload("claude"));
  };

  const handoff = new HandoffController(context, log);
  void handoff.sync();
  // Handoff and compaction signals come from sessions running the hooks in ~/.claude/settings.json,
  // i.e. the default group's: a window of an isolated group never acts on them.
  if (win.isDefault()) {
    context.subscriptions.push(handoff.watchCompaction(() => void poller?.switchNow("claude", "compacted near the limit")));
  }
  service.onSwitched((provider) => {
    const result = provider === "claude" && win.isDefault() ? handoff.onSwitched() : undefined;
    if (!result || service.pendingReload("claude")) {
      return; // a window that must reload first gets its new conversation after the reload
    }
    const open = () => vscode.commands.executeCommand("claude-vscode.newConversation").then(undefined, (e: Error) => log(`new conversation: ${e.message}`));
    if (!result.handoff) {
      void vscode.window.showInformationMessage(`AgentPool: ${result.note}`);
      return;
    }
    const mode = handoff.newConversationMode();
    if (mode === "auto") {
      void open();
      void vscode.window.showInformationMessage(`AgentPool: ${result.note} Opened a new conversation — type "continue".`);
    } else if (mode === "ask") {
      void vscode.window.showInformationMessage(`AgentPool: ${result.note}`, "New conversation").then((c) => c && open());
    }
  });
  let poller: UsagePoller | undefined;
  let lastReloadAsk = 0;
  // One leader per account group for Claude; Codex is led by the default group's leader.
  const leader = new LeaderLock((isLeader) => {
    log(isLeader ? "this window reads usage (leader)" : "another window reads usage");
    if (isLeader) {
      poller ??= new UsagePoller(
        service,
        (provider, needsReload, message) => void reportOutcome({ needsReload, notes: [] }, message, provider),
        (message) => void vscode.window.showWarningMessage(message),
        (provider) => leader.isLeader() && (provider === "claude" || win.isDefault()),
        // The handoff hooks live in ~/.claude/settings.json, which an isolated group does not share.
        win.isDefault() ? handoff : undefined
      );
      poller.onReloadNeeded = (provider) => {
        // At most every 10 minutes: the account is at its limit and only a reload unblocks it.
        if (Date.now() - lastReloadAsk < 10 * 60_000) {
          return;
        }
        lastReloadAsk = Date.now();
        if (vscode.workspace.getConfiguration("agentPool").get<boolean>("autoReloadAfterSwitch")) {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
          return;
        }
        void vscode.window
          .showWarningMessage(
            `AgentPool: ${provider === "claude" ? "Claude Code" : "Codex"} needs a new account now, but this window must reload once first (it still runs the previous account).`,
            { modal: true, detail: "Reload now and AgentPool switches automatically right after. Until then auto switch cannot act in this window." },
            "Reload Window"
          )
          .then((c) => c && vscode.commands.executeCommand("workbench.action.reloadWindow"));
      };
      poller.start();
    } else {
      poller?.stop();
    }
  }, win.isDefault() ? "leader.json" : `leader-${win.id}.json`);

  const rating = new RatingPrompt(context.globalState);
  service.onSwitched(() => void rating.recordSwitch());
  pool.onChange(rerender);
  pool.onChange(() => {
    void scope.apply().catch((e: Error) => log(`account group setup: ${e.message}`));
    view.description = win.on() ? `${win.name()} · v${version}` : `v${version}`;
    if (win.wanted() !== win.id && !win.reloadAsked) {
      win.reloadAsked = true; // once per window (e.g. assigned from another window): the view keeps showing it
      void vscode.window
        .showWarningMessage(
          `AgentPool: this workspace now uses the account group "${groupName(pool.get(), win.wanted())}". Reload the window so Claude Code here uses it.`,
          "Reload Window"
        )
        .then((c) => c && vscode.commands.executeCommand("workbench.action.reloadWindow"));
    }
  });
  pool.watch();
  service.onActiveChange(() => void statusBar.refreshPlaces());
  registerCommands(context, service, () => (leader.isLeader() ? poller : undefined), rerender, win);

  // Followers still need to notice switches made elsewhere (terminal logins, other windows).
  const followerTimer = setInterval(() => {
    if (!leader.isLeader()) {
      void service.refreshActive().then(rerender);
    }
  }, FOLLOWER_REFRESH_MS);

  context.subscriptions.push(
    output,
    view,
    { dispose: () => statusBar.dispose() },
    { dispose: () => leader.dispose() },
    { dispose: () => poller?.stop() },
    { dispose: () => pool.dispose() },
    { dispose: () => clearInterval(followerTimer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentPool.claude.handoff")) {
        void handoff.sync();
      }
      if (e.affectsConfiguration("agentPool") || e.affectsConfiguration("claudeCode.environmentVariables")) {
        service.providers.forEach((p) => p.invalidate());
        void service.refreshActive().then(() => statusBar.refreshPlaces());
        rerender();
      }
    }),
    context.secrets.onDidChange(() => service.providers.forEach((p) => p.invalidate()))
  );

  leader.start();
  void onboard(service, context.globalState)
    .catch((e: Error) => log(`onboarding failed: ${e.message}`))
    .then(() => service.refreshActive())
    .then(() => statusBar.refreshPlaces());
  rerender();
}

/** What identifies this window's workspace for account groups: its .code-workspace file or first folder. */
function workspaceKey(): string | undefined {
  const file = vscode.workspace.workspaceFile;
  const raw = file?.scheme === "file" ? file.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!raw) {
    return undefined;
  }
  try {
    return fs.realpathSync.native(raw); // one key however the folder was opened (case, symlinks)
  } catch {
    return raw;
  }
}

/** Temporary login folders left by a sign-in interrupted by a reload (older than 15 min). */
function removeStaleLogins(log: (m: string) => void): void {
  try {
    for (const name of fs.readdirSync(poolHome())) {
      const dir = path.join(poolHome(), name);
      if (/^(codex-)?login-\d+$/.test(name) && Date.now() - fs.statSync(dir).mtimeMs > 15 * 60_000) {
        fs.rmSync(dir, { recursive: true, force: true });
        log(`removed stale login folder ${name}`);
      }
    }
  } catch {
    /* nothing to clean */
  }
}

export function deactivate(): void {
  /* disposables registered on the context clean up */
}
