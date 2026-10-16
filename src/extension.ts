import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AccountService } from "./account-service";
import { LeaderLock } from "./core/leader-lock";
import { HandoffController } from "./handoff/handoff-controller";
import { poolHome, PoolStore } from "./core/pool-store";
import { VsSecretVault } from "./core/secret-vault";
import { ClaudeProvider } from "./providers/claude/claude-provider";
import { VscodeScope } from "./providers/claude/vscode-scope";
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
  const service = new AccountService(pool, new VsSecretVault(context.secrets), log);
  const scope = new VscodeScope(log);
  service.register(new ClaudeProvider(service.providerContext(), scope));
  service.register(new CodexProvider(service.providerContext()));
  removeStaleLogins(log);
  if (scope.isActive()) {
    scope.prepareFolder(); // pick up shared items added since
  }

  const statusBar = new StatusBar(service);
  const tree = new AccountsTree(service);
  const view = vscode.window.createTreeView("agentPool.accounts", {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: false,
  });
  const version = String(context.extension.packageJSON.version ?? "");
  view.description = `v${version}`;
  log(`AgentPool v${version} on ${process.platform} (VS Code ${vscode.version})`);
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
  };

  const handoff = new HandoffController(context, log);
  void handoff.sync();
  context.subscriptions.push(handoff.watchCompaction(() => void poller?.switchNow("claude", "compacted near the limit")));
  service.onSwitched((provider) => {
    const result = provider === "claude" ? handoff.onSwitched() : undefined;
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
  const leader = new LeaderLock((isLeader) => {
    log(isLeader ? "this window reads usage (leader)" : "another window reads usage");
    if (isLeader) {
      poller ??= new UsagePoller(
        service,
        (provider, needsReload, message) => void reportOutcome({ needsReload, notes: [] }, message, provider),
        (message) => void vscode.window.showWarningMessage(message),
        () => leader.isLeader(),
        handoff
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
  });

  const rating = new RatingPrompt(context.globalState);
  service.onSwitched(() => void rating.recordSwitch());
  pool.onChange(rerender);
  pool.watch();
  service.onActiveChange(() => void statusBar.refreshPlaces());
  registerCommands(context, service, () => (leader.isLeader() ? poller : undefined), rerender);

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
