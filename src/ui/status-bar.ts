import * as vscode from "vscode";
import { AccountService } from "../account-service";
import { ordered } from "../core/priority";
import { maxUsed, PROVIDER_LABEL, ProviderId } from "../core/types";
import { Place } from "../providers/provider";
import { longThreshold, threshold } from "../usage-poller";
import { ago, bar, shownWindows, until } from "./format";

const ICON: Record<ProviderId, string> = { claude: "$(sparkle)", codex: "$(code)" };
const STALE_AFTER_MS = 15 * 60_000;
const COMMANDS = ["workbench.action.reloadWindow", "agentPool.setThreshold", "agentPool.switchTo", "agentPool.refresh", "agentPool.switch", "agentPool.addAccount", "agentPool.toggleTerminalScope"];

/** One status bar item per tool, with every account's quota in its hover tooltip. */
export class StatusBar {
  private readonly items = new Map<ProviderId, vscode.StatusBarItem>();
  private places = new Map<ProviderId, Place[]>();
  /** Shown in the tooltip footer, so people can tell which version they run. */
  version = "";

  constructor(private readonly service: AccountService) {
    (["claude", "codex"] as ProviderId[]).forEach((p, i) => {
      const item = vscode.window.createStatusBarItem(`agentPool.${p}`, vscode.StatusBarAlignment.Right, 100 - i);
      item.name = `AgentPool ${PROVIDER_LABEL[p]}`;
      item.command = { command: "agentPool.switch", title: "Switch", arguments: [p] };
      this.items.set(p, item);
    });
  }

  /** Re-reads where each tool's logins live (for the tooltip), then renders. */
  async refreshPlaces(): Promise<void> {
    for (const [id, provider] of this.service.providers) {
      this.places.set(id, await provider.places().catch(() => []));
    }
    this.render();
  }

  render(): void {
    const data = this.service.pool.get();
    for (const [provider, item] of this.items) {
      const accounts = ordered(data, provider);
      if (accounts.length === 0) {
        item.hide();
        continue;
      }
      const activeId = this.service.activeId(provider);
      const active = accounts.find((a) => a.id === activeId);
      const used = active ? maxUsed(data.usage[active.id]?.snapshot, Date.now()) : undefined;
      const scope = provider === "claude" ? this.claudeScopeTag() : "";
      const stale = active && Date.now() - (data.usage[active.id]?.snapshot?.fetchedAt ?? 0) > STALE_AFTER_MS;
      const reload = this.service.pendingReload(provider) ? " $(debug-restart) reload" : "";
      item.text = `${ICON[provider]} ${active?.label ?? "not saved"}${used !== undefined ? ` ${used}%${stale ? "?" : ""}` : ""}${reload}`;
      item.backgroundColor = used === undefined || used < 80
        ? undefined
        : new vscode.ThemeColor(used >= this.threshold() ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground");
      item.tooltip = this.tooltip(provider, scope);
      item.show();
    }
  }

  dispose(): void {
    this.items.forEach((i) => i.dispose());
  }

  private tooltip(provider: ProviderId, scope: string): vscode.MarkdownString {
    const data = this.service.pool.get();
    const cfg = vscode.workspace.getConfiguration("agentPool");
    const accounts = ordered(data, provider);
    const activeId = this.service.activeId(provider);
    const md = new vscode.MarkdownString("", true);
    md.isTrusted = { enabledCommands: COMMANDS };
    md.supportHtml = false;

    const auto = cfg.get<boolean>("autoSwitch.enabled", true)
      ? `auto ✓ [5h ${this.threshold()}% · weekly ${longThreshold()}%](command:agentPool.setThreshold "Change the auto switch threshold")`
      : "auto off";
    const order = accounts.filter((a) => a.inRotation).map((a) => a.label).join(" → ");
    md.appendMarkdown(`**${PROVIDER_LABEL[provider]}**${scope}  \n$(list-ordered) ${order || "—"} · ${auto}\n\n`);
    const note = this.service.autoNote.get(provider);
    if (note) {
      md.appendMarkdown(`$(info) ${note}\n\n`);
    }
    if (this.service.pendingReload(provider)) {
      md.appendMarkdown(
        `$(warning) **[Reload this window](command:workbench.action.reloadWindow)**: ${PROVIDER_LABEL[provider]} here still runs the previous account. Auto switch waits until then.\n\n`
      );
    }
    md.appendMarkdown("---\n\n");

    for (const a of accounts) {
      const record = data.usage[a.id];
      const isActive = a.id === activeId;
      const head = `${isActive ? "$(pass-filled)" : "$(circle-large-outline)"} **${a.label}**${a.plan ? ` · ${a.plan}` : ""}${a.email ? ` · ${a.email}` : ""}${a.inRotation ? "" : " · _excluded_"}`;
      const action = isActive
        ? ""
        : ` [$(arrow-swap) Switch](command:agentPool.switchTo?${encodeURIComponent(JSON.stringify([a.id]))})`;
      md.appendMarkdown(`${head}${action}  \n`);
      if (a.needsReauth) {
        md.appendMarkdown(`$(warning) needs sign-in again — use **Add account**  \n`);
      } else if (record?.snapshot) {
        if (Date.now() - record.snapshot.fetchedAt > STALE_AFTER_MS) {
          md.appendMarkdown(`$(history) _last read ${ago(record.snapshot.fetchedAt)}${record.error ? " (reading fails now)" : ""}_  \n`);
        }
        for (const w of shownWindows(record.snapshot.windows)) {
          const reset = w.resetsAt ? ` · reset ${until(w.resetsAt)}` : "";
          md.appendMarkdown(`\`${w.label.padEnd(4)}\` \`${bar(w.percent)}\` ${w.percent}%${reset}  \n`);
        }
      } else {
        md.appendMarkdown(`_${record?.error ? `usage unavailable: ${escapeMd(record.error.slice(0, 80))}` : "reading usage…"}_  \n`);
      }
      md.appendMarkdown("\n");
    }

    const places = this.places.get(provider) ?? [];
    if (provider === "claude" && places.length > 1) {
      const names = places.map((p) => `${p.label}: ${this.labelOf(p)}`).join(" · ");
      md.appendMarkdown(`---\n\n$(device-desktop) ${names}\n\n`);
    }
    const newest = Math.max(0, ...accounts.map((a) => data.usage[a.id]?.snapshot?.fetchedAt ?? 0));
    md.appendMarkdown(
      `---\n\n[$(refresh) Refresh](command:agentPool.refresh) · [$(add) Add account](command:agentPool.addAccount) · updated ${ago(newest || undefined)}${this.version ? ` · AgentPool v${this.version}` : ""}`
    );
    if (provider === "claude") {
      const on = cfg.get<boolean>("claude.switchTerminalToo") ?? false;
      md.appendMarkdown(`  \n[${on ? "$(check)" : "$(circle-large-outline)"} Switch terminal too](command:agentPool.toggleTerminalScope)`);
    }
    return md;
  }

  private labelOf(place: Place): string {
    return (place.accountId && this.service.account(place.accountId)?.label) || place.email || "not saved";
  }

  private claudeScopeTag(): string {
    const on = vscode.workspace.getConfiguration("agentPool").get<boolean>("claude.switchTerminalToo") ?? false;
    return on ? " (VS Code + terminal)" : " (VS Code only)";
  }

  private threshold(): number {
    return threshold();
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]<>]/g, "\\$&");
}
