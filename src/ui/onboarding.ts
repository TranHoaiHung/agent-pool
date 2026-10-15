import * as vscode from "vscode";
import { AccountService } from "../account-service";
import { PROVIDER_LABEL, PROVIDERS } from "../core/types";

const KEY = "agentPool.onboarded";

/**
 * First run only: saves the logins Claude Code and Codex already use, so the status bar
 * shows quota right after install, then says what to do next. Read-only: nothing switches.
 */
export async function onboard(service: AccountService, memento: vscode.Memento): Promise<void> {
  if (memento.get<boolean>(KEY)) {
    return;
  }
  await memento.update(KEY, true);
  const found: string[] = [];
  for (const provider of PROVIDERS) {
    if (service.pool.get().accounts.some((a) => a.provider === provider)) {
      continue;
    }
    try {
      const meta = await service.saveCurrent(provider);
      if (meta) {
        found.push(`${PROVIDER_LABEL[provider]} (${meta.email ?? meta.label})`);
      }
    } catch (e) {
      service.log(`[${provider}] first-run save skipped: ${(e as Error).message}`);
    }
  }
  const text = found.length
    ? `AgentPool saved the account you use: ${found.join(", ")}. Add another account to switch between them; hover the status bar for quota.`
    : "AgentPool is ready. Sign in to Claude Code or Codex, then add your accounts here.";
  const choice = await vscode.window.showInformationMessage(text, "Add account", "Open AgentPool");
  if (choice === "Add account") {
    await vscode.commands.executeCommand("agentPool.addAccount");
  } else if (choice === "Open AgentPool") {
    await vscode.commands.executeCommand("agentPool.accounts.focus");
  }
}
