import * as vscode from "vscode";

const REVIEW_URL = "https://marketplace.visualstudio.com/items?itemName=TranHoaiHung.agent-pool&ssr=false#review-details";
const SWITCHES_BEFORE_ASK = 5;
const DAYS_BEFORE_ASK = 3;
const LATER_DAYS = 14;
const KEY = "agentPool.ratingPrompt";

interface State {
  firstSeen: number;
  switches: number;
  /** Do not ask before this time. */
  notBefore?: number;
  done?: boolean;
}

/**
 * Asks for a rating at most twice, and only once AgentPool has proven useful: after a few
 * successful switches and a few days of use. "Don't ask again" and "Rate" end it for good.
 */
export class RatingPrompt {
  /** A prompt is on screen: switches meanwhile must not open a second one. */
  private asking = false;

  constructor(private readonly memento: vscode.Memento) {}

  async recordSwitch(): Promise<void> {
    const state = this.state();
    if (state.done || this.asking) {
      return;
    }
    state.switches += 1;
    await this.memento.update(KEY, state);
    const now = Date.now();
    const usedLongEnough = now - state.firstSeen >= DAYS_BEFORE_ASK * 86_400_000;
    if (state.switches < SWITCHES_BEFORE_ASK || !usedLongEnough || (state.notBefore && now < state.notBefore)) {
      return;
    }
    this.asking = true;
    const choice = await vscode.window.showInformationMessage(
      "Is AgentPool keeping you clear of usage limits? A ⭐ rating helps other developers find it.",
      "Rate AgentPool",
      "Later",
      "Don't ask again"
    );
    if (choice === "Later" || choice === undefined) {
      // Later or dismissed: one more ask in two weeks, never a third.
      state.done = state.notBefore !== undefined;
      state.notBefore = now + LATER_DAYS * 86_400_000;
    } else {
      state.done = true;
      if (choice === "Rate AgentPool") {
        await vscode.env.openExternal(vscode.Uri.parse(REVIEW_URL));
      }
    }
    await this.memento.update(KEY, state);
    this.asking = false;
  }

  private state(): State {
    const saved = this.memento.get<State>(KEY);
    if (saved) {
      return { ...saved };
    }
    const fresh: State = { firstSeen: Date.now(), switches: 0 };
    void this.memento.update(KEY, fresh);
    return fresh;
  }
}
