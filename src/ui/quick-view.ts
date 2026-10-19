import * as vscode from "vscode";
import { AccountService } from "../account-service";
import { AccountMeta, maxUsed, PROVIDER_LABEL, PROVIDERS } from "../core/types";
import { compactUsage, until } from "./format";

type Item = vscode.QuickPickItem & { account?: AccountMeta; command?: string };

const REMOVE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Remove this account" };

/**
 * Every account of every tool in one list: select an idle one to switch to it, or use its
 * trash button to remove it.
 */
export async function showQuickView(service: AccountService, switchTo: (a: AccountMeta) => Promise<void>): Promise<void> {
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = "AgentPool — select an account to switch, 🗑 to remove";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = items(service);

  const picked = await new Promise<Item | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
    qp.onDidTriggerItemButton((e) => {
      if (e.item.account) {
        resolve(undefined);
        qp.hide();
        void vscode.commands.executeCommand("agentPool.remove", e.item.account.id);
      }
    });
    qp.show();
  });
  qp.dispose();

  if (picked?.account && picked.account.id !== service.activeId(picked.account.provider)) {
    await switchTo(picked.account);
  } else if (picked?.command) {
    await vscode.commands.executeCommand(picked.command);
  }
}

function items(service: AccountService): Item[] {
  const data = service.pool.get();
  const result: Item[] = [];
  for (const provider of PROVIDERS) {
    const accounts = service.ordered(provider);
    if (accounts.length === 0) {
      continue;
    }
    result.push({ label: PROVIDER_LABEL[provider], kind: vscode.QuickPickItemKind.Separator });
    const activeId = service.activeId(provider);
    accounts.forEach((a, i) => {
      const record = data.usage[a.id];
      const used = maxUsed(record?.snapshot, Date.now());
      const nextReset = record?.snapshot?.windows
        .filter((w) => w.resetsAt !== null && w.resetsAt > Date.now() && w.percent > 0)
        .sort((x, y) => (x.resetsAt as number) - (y.resetsAt as number))[0];
      const inUse = a.id === activeId;
      const icon = inUse ? "$(pass-filled)" : a.needsReauth ? "$(warning)" : used !== undefined && used >= 95 ? "$(error)" : "$(circle-large-outline)";
      result.push({
        label: `${icon} ${i + 1}. ${a.label}`,
        description: a.needsReauth ? "needs sign-in" : compactUsage(record),
        detail: [a.plan, a.email, nextReset ? `next reset ${until(nextReset.resetsAt)}` : undefined, inUse ? "in use" : "select to switch"]
          .filter(Boolean)
          .join(" · "),
        account: a,
        buttons: [REMOVE],
      });
    });
  }
  result.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  result.push({ label: "$(refresh) Refresh usage", command: "agentPool.refresh" });
  result.push({ label: "$(add) Add account", command: "agentPool.addAccount" });
  result.push({ label: "$(dashboard) Auto switch threshold…", command: "agentPool.setThreshold" });
  result.push({ label: "$(list-ordered) Reorder priority…", command: "agentPool.accounts.focus" });
  result.push({ label: "$(organization) Account group for this workspace…", command: "agentPool.setWorkspaceGroup" });
  return result;
}
