export type ProviderId = "claude" | "codex";

export const PROVIDERS: ProviderId[] = ["claude", "codex"];

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** One usage limit of an account, normalised across providers. */
export interface UsageWindow {
  kind: string;
  label: string;
  /** 0..100 */
  percent: number;
  /** Epoch ms, or null when the window is not running. */
  resetsAt: number | null;
}

export interface UsageSnapshot {
  fetchedAt: number;
  windows: UsageWindow[];
  plan?: string;
  /** The provider says a limit is used up. */
  limitReached?: boolean;
}

/** Last usage read of an account, including failures. */
export interface UsageRecord {
  snapshot?: UsageSnapshot;
  error?: string;
  errorAt?: number;
  /** Do not ask again before this time (rate limit backoff). */
  holdUntil?: number;
}

/** Non-secret account metadata, kept in the shared pool file. */
export interface AccountMeta {
  id: string;
  provider: ProviderId;
  label: string;
  email?: string;
  orgName?: string;
  plan?: string;
  /** Stable identity: claude `accountUuid:orgUuid`, codex `userId:accountId`. */
  identityKey: string;
  /** Taken into account by auto switch. */
  inRotation: boolean;
  needsReauth?: boolean;
  addedAt: number;
  /** Non-secret provider data, e.g. Claude's `oauthAccount` fields. */
  extra?: Record<string, unknown>;
}

export interface SwitchRecord {
  at: number;
  fromId?: string;
  toId: string;
  automatic: boolean;
  /** Why an automatic switch happened; only a "threshold" one is ever gone back from. */
  reason?: "threshold" | "preferred";
  /** Last switch that needs a reload: windows started before it run an older account. */
  reloadAt?: number;
}

export interface PoolData {
  version: 1;
  accounts: AccountMeta[];
  /** Priority order per provider, highest first. */
  order: Record<ProviderId, string[]>;
  usage: Record<string, UsageRecord>;
  lastSwitch: Partial<Record<ProviderId, SwitchRecord>>;
  /** Exhaustion notices already shown, keyed by provider. */
  noticeKeys: Partial<Record<ProviderId, string>>;
}

export function emptyPool(): PoolData {
  return {
    version: 1,
    accounts: [],
    order: { claude: [], codex: [] },
    usage: {},
    lastSwitch: {},
    noticeKeys: {},
  };
}

/** Claude Code's OAuth block (`claudeAiOauth` in its credential document). */
export interface ClaudeOAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  clientId?: string;
  [key: string]: unknown;
}

/** Codex's `auth.json`. */
export interface CodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

export type AccountSecret =
  | { kind: "claude"; oauth: ClaudeOAuth }
  | { kind: "codex"; auth: CodexAuth };

export interface Identity {
  identityKey: string;
  email?: string;
  orgName?: string;
  plan?: string;
  /** Extra fields a provider wants to keep (e.g. Claude's oauthAccount). */
  raw?: Record<string, unknown>;
}

/** Highest share used among limits still running. */
export function maxUsed(snapshot: UsageSnapshot | undefined, now: number): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  let max = 0;
  for (const w of snapshot.windows) {
    if (w.resetsAt !== null && w.resetsAt <= now) {
      continue; // window already reset
    }
    max = Math.max(max, w.percent);
  }
  return snapshot.limitReached ? Math.max(max, 100) : max;
}
