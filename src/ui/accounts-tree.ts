import * as vscode from "vscode";
import { AccountService } from "../account-service";
import { ordered, placeBefore } from "../core/priority";
import { AccountMeta, PROVIDER_LABEL, PROVIDERS, ProviderId } from "../core/types";
import { prioritySaved } from "./commands";
import { compactUsage } from "./format";

const MIME = "application/vnd.code.tree.agentpool.accounts";

export type Node = { kind: "provider"; provider: ProviderId } | { kind: "account"; account: AccountMeta; rank: number };

/** Accounts grouped by tool, in priority order; drag and drop reorders them. */
export class AccountsTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly service: AccountService) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const data = this.service.pool.get();
    if (!node) {
      return PROVIDERS.filter((p) => data.accounts.some((a) => a.provider === p)).map((provider) => ({ kind: "provider", provider }));
    }
    if (node.kind === "provider") {
      return ordered(data, node.provider).map((account, i) => ({ kind: "account", account, rank: i + 1 }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const cfg = vscode.workspace.getConfiguration("agentPool");
    if (node.kind === "provider") {
      const item = new vscode.TreeItem(PROVIDER_LABEL[node.provider], vscode.TreeItemCollapsibleState.Expanded);
      const auto = cfg.get<boolean>("autoSwitch.enabled", true) ? "auto switch on" : "auto switch off";
      const scope = node.provider === "claude"
        ? cfg.get<boolean>("claude.switchTerminalToo") ? " · VS Code + terminal" : " · VS Code only"
        : "";
      item.description = `${auto}${scope}`;
      item.contextValue = "provider";
      return item;
    }
    const { account, rank } = node;
    const data = this.service.pool.get();
    const isActive = this.service.activeId(account.provider) === account.id;
    const item = new vscode.TreeItem(`${rank}. ${account.label}`, vscode.TreeItemCollapsibleState.None);
    const pinned = this.service.pool.get().terminalPin === account.id;
    const inTerminal = pinned ? "📌 terminal · " : this.service.heldElsewhere(account.provider) === account.id ? "in terminal · " : "";
    item.description = account.needsReauth ? "needs sign-in" : inTerminal + compactUsage(data.usage[account.id]);
    item.tooltip = [account.email, account.orgName, account.plan, account.inRotation ? undefined : "excluded from auto switch"]
      .filter(Boolean)
      .join(" · ");
    item.iconPath = account.needsReauth
      ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"))
      : isActive
        ? new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"))
        : account.inRotation
          ? new vscode.ThemeIcon("circle-large-outline")
          : new vscode.ThemeIcon("circle-slash");
    item.contextValue = isActive ? "account-active" : "account-idle";
    if (!isActive) {
      item.command = undefined; // switching is explicit (inline button / context menu)
    }
    return item;
  }

  handleDrag(source: readonly Node[], transfer: vscode.DataTransfer): void {
    const ids = source.filter((n) => n.kind === "account").map((n) => (n as { account: AccountMeta }).account.id);
    transfer.set(MIME, new vscode.DataTransferItem(ids));
  }

  async handleDrop(target: Node | undefined, transfer: vscode.DataTransfer): Promise<void> {
    const ids = transfer.get(MIME)?.value as string[] | undefined;
    if (!ids?.length) {
      return;
    }
    await this.service.pool.mutate((data) => {
      for (const id of ids) {
        const account = data.accounts.find((a) => a.id === id);
        if (!account) {
          continue;
        }
        if (target?.kind === "account" && target.account.provider === account.provider) {
          placeBefore(data, id, target.account.id); // dropped on an account: take its place
        } else if (!target || (target.kind === "provider" && target.provider === account.provider)) {
          placeBefore(data, id, ordered(data, account.provider)[0]?.id); // dropped on the group: first
        }
      }
    });
    prioritySaved();
  }
}
