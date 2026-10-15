import * as vscode from "vscode";
import { AccountService } from "../account-service";
import { ordered } from "../core/priority";
import { AccountMeta, maxUsed, PROVIDER_LABEL, PROVIDERS } from "../core/types";
import { compactUsage, until } from "./format";

type Item = vscode.QuickPickItem & { account?: AccountMeta; command?: string };

/** Every account of every tool in one list; picking an idle one switches to it. */
export async function showQuickView(service: AccountService, switchTo: (a: AccountMeta) => Promise<void>): Promise<void> {
  const data = service.pool.get();
  const items: Item[] = [];
  for (const provider of PROVIDERS) {
    const accounts = ordered(data, provider);
    if (accounts.length === 0) {
      continue;
    }
    items.push({ label: PROVIDER_LABEL[provider], kind: vscode.QuickPickItemKind.Separator });
    const activeId = service.activeId(provider);
    accounts.forEach((a, i) => {
      const record = data.usage[a.id];
      const used = maxUsed(record?.snapshot, Date.now());
      const nextReset = record?.snapshot?.windows
        .filter((w) => w.resetsAt !== null && w.resetsAt > Date.now() && w.percent > 0)
        .sort((x, y) => (x.resetsAt as number) - (y.resetsAt as number))[0];
      const icon = a.id === activeId ? "$(pass-filled)" : a.needsReauth ? "$(warning)" : used !== undefined && used >= 95 ? "$(error)" : "$(circle-large-outline)";
      items.push({
        label: `${icon} ${i + 1}. ${a.label}`,
        description: a.needsReauth ? "needs sign-in" : compactUsage(record),
        detail: [a.plan, a.email, nextReset ? `next reset ${until(nextReset.resetsAt)}` : undefined, a.id === activeId ? "in use" : "select to switch"]
          .filter(Boolean)
          .join(" · "),
        account: a.id === activeId ? undefined : a,
      });
    });
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(refresh) Refresh usage", command: "agentPool.refresh" });
  items.push({ label: "$(add) Add account", command: "agentPool.addAccount" });
  items.push({ label: "$(list-ordered) Reorder priority…", command: "agentPool.accounts.focus" });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "AgentPool — accounts & quota (select an account to switch)",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (pick?.account) {
    await switchTo(pick.account);
  } else if (pick?.command) {
    await vscode.commands.executeCommand(pick.command);
  }
}
