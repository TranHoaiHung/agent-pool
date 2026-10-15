import { CodexAuth, Identity, UsageSnapshot, UsageWindow } from "../../core/types";
import { HttpError, httpJson } from "../http";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Decodes a JWT payload without verifying it (identification only, no trust decision). */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const part = token?.split(".")[1];
  if (!part) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Identifies a Codex login from its ID token, with no network call. */
export function codexIdentity(auth: CodexAuth): Identity | undefined {
  const claims = jwtClaims(auth.tokens?.id_token);
  const openai = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const accountId = (openai.chatgpt_account_id as string | undefined) ?? auth.tokens?.account_id;
  const userId = (openai.chatgpt_user_id as string | undefined) ?? (openai.user_id as string | undefined);
  if (!accountId && !userId) {
    return undefined;
  }
  const plan = openai.chatgpt_plan_type as string | undefined;
  return {
    identityKey: `${userId ?? ""}:${accountId ?? ""}`,
    email: claims.email as string | undefined,
    plan: plan ? plan.replace(/^\w/, (c) => c.toUpperCase()) : undefined,
  };
}

export function isCodexTokenExpiring(auth: CodexAuth, now = Date.now()): boolean {
  const exp = jwtClaims(auth.tokens?.access_token).exp;
  return typeof exp === "number" && exp * 1000 - 5 * 60_000 < now;
}

/** Renews a parked Codex login. Each token in the answer is written only if present. */
export async function refreshCodex(auth: CodexAuth): Promise<CodexAuth> {
  if (!auth.tokens?.refresh_token) {
    throw new HttpError(400, "invalid_grant: no refresh token");
  }
  const data = await httpJson<{ id_token?: string; access_token?: string; refresh_token?: string }>(TOKEN_URL, {
    method: "POST",
    body: { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: auth.tokens.refresh_token },
  });
  return {
    ...auth,
    tokens: {
      ...auth.tokens,
      id_token: data.id_token ?? auth.tokens.id_token,
      access_token: data.access_token ?? auth.tokens.access_token,
      refresh_token: data.refresh_token ?? auth.tokens.refresh_token,
    },
    // Codex reads a login without last_refresh as having no token data.
    last_refresh: new Date().toISOString(),
  };
}

export async function fetchCodexUsage(auth: CodexAuth): Promise<UsageSnapshot> {
  const accountId = auth.tokens?.account_id ?? codexIdentity(auth)?.identityKey.split(":")[1];
  if (!auth.tokens?.access_token || !accountId) {
    throw new Error("Codex login has no ChatGPT tokens (API-key logins have no plan usage).");
  }
  const raw = await httpJson<RawCodexUsage>(USAGE_URL, {
    headers: { Authorization: `Bearer ${auth.tokens.access_token}`, "ChatGPT-Account-ID": accountId },
  });
  return parseCodexUsage(raw, Date.now());
}

interface RawCodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}
export interface RawCodexUsage {
  plan_type?: string;
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: RawCodexWindow | null;
    secondary_window?: RawCodexWindow | null;
  } | null;
}

/** Windows live under `rate_limit`; their length, not their slot, says which is which. */
export function parseCodexUsage(raw: RawCodexUsage, now: number): UsageSnapshot {
  const windows: UsageWindow[] = [];
  for (const slot of ["primary_window", "secondary_window"] as const) {
    const w = raw.rate_limit?.[slot];
    if (!w || typeof w.used_percent !== "number" || w.used_percent < 0) {
      continue;
    }
    windows.push({
      kind: slot,
      label: windowLabel(w.limit_window_seconds),
      percent: Math.max(0, Math.min(100, Math.round(w.used_percent))),
      resetsAt: typeof w.reset_at === "number" ? w.reset_at * 1000 : null,
    });
  }
  return {
    fetchedAt: now,
    windows,
    plan: raw.plan_type ? raw.plan_type.replace(/^\w/, (c) => c.toUpperCase()) : undefined,
    limitReached: raw.rate_limit?.limit_reached === true,
  };
}

export function windowLabel(seconds: number | undefined): string {
  if (!seconds) {
    return "limit";
  }
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 7 ? "7d" : `${days}d`;
  }
  if (seconds % 3_600 === 0) {
    return `${seconds / 3_600}h`;
  }
  return `${Math.round(seconds / 60)}m`;
}
