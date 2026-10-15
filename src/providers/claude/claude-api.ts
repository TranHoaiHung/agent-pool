import { ClaudeOAuth, Identity, UsageSnapshot, UsageWindow } from "../../core/types";
import { HttpError, httpJson } from "../http";

/** Public values of the Claude Code client; the OAuth flow is not officially documented. */
const API_BASE = "https://api.anthropic.com";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA = { "anthropic-beta": "oauth-2025-04-20" };
const DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];

/** Expired, or within 5 minutes of it (Claude Code renews at the same margin). */
export function isExpiring(oauth: ClaudeOAuth, now = Date.now()): boolean {
  return typeof oauth.expiresAt === "number" && oauth.expiresAt - 5 * 60_000 < now;
}

/**
 * Renews a login. The refresh token is single-use: the caller must persist the result
 * everywhere the old token lives, and must hold Claude Code's refresh lock when the login
 * is also live in a Claude Code slot.
 */
export async function refreshClaude(oauth: ClaudeOAuth): Promise<ClaudeOAuth> {
  const body = {
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId ?? CLIENT_ID,
    scope: (oauth.scopes?.length ? oauth.scopes : DEFAULT_SCOPES).join(" "),
  };
  const data = await httpJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
  }>(TOKEN_URL, { method: "POST", body, headers: BETA });
  if (!data.access_token) {
    throw new HttpError(200, "No access_token in refresh answer");
  }
  const now = Date.now();
  return {
    ...oauth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? oauth.refreshToken,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : oauth.expiresAt,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : oauth.refreshTokenExpiresAt,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : oauth.scopes,
  };
}

interface ProfileAnswer {
  account?: { uuid?: string; email?: string; display_name?: string; full_name?: string };
  organization?: { uuid?: string; name?: string; organization_type?: string; rate_limit_tier?: string };
}

/** Asks Anthropic whose login this is (the endpoint Claude Code calls after login). */
export async function fetchClaudeIdentity(accessToken: string): Promise<Identity> {
  const p = await httpJson<ProfileAnswer>(`${API_BASE}/api/oauth/profile`, {
    headers: { ...BETA, Authorization: `Bearer ${accessToken}` },
  });
  const accountUuid = p.account?.uuid;
  if (!accountUuid) {
    throw new HttpError(200, "Profile answer has no account");
  }
  return {
    identityKey: `${accountUuid}:${p.organization?.uuid ?? ""}`,
    email: p.account?.email,
    orgName: p.organization?.name,
    plan: planName(p.organization?.organization_type, p.organization?.rate_limit_tier),
    raw: {
      accountUuid,
      emailAddress: p.account?.email,
      organizationUuid: p.organization?.uuid,
      organizationName: p.organization?.name,
      displayName: p.account?.display_name,
      fullName: p.account?.full_name,
    },
  };
}

export async function fetchClaudeUsage(accessToken: string): Promise<UsageSnapshot> {
  const raw = await httpJson<RawUsage>(`${API_BASE}/api/oauth/usage`, {
    headers: { ...BETA, Authorization: `Bearer ${accessToken}` },
  });
  return parseClaudeUsage(raw, Date.now());
}

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface RawLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}
export interface RawUsage {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  seven_day_opus?: RawWindow | null;
  seven_day_sonnet?: RawWindow | null;
  limits?: RawLimit[];
}

/** Normalises the usage answer; prefers the `limits` list, falls back to named windows. */
export function parseClaudeUsage(raw: RawUsage, now: number): UsageSnapshot {
  const windows: UsageWindow[] = [];
  if (Array.isArray(raw.limits) && raw.limits.length > 0) {
    for (const l of raw.limits) {
      if (typeof l.percent !== "number" || !l.kind) {
        continue;
      }
      windows.push({
        kind: l.kind,
        label: limitLabel(l.kind, l.scope?.model?.display_name ?? undefined),
        percent: clamp(l.percent),
        resetsAt: toMs(l.resets_at),
      });
    }
  } else {
    const named: Array<[keyof RawUsage, string, string]> = [
      ["five_hour", "session", "5h"],
      ["seven_day", "weekly_all", "7d"],
      ["seven_day_opus", "weekly_opus", "7d Opus"],
      ["seven_day_sonnet", "weekly_sonnet", "7d Sonnet"],
    ];
    for (const [key, kind, label] of named) {
      const w = raw[key] as RawWindow | null | undefined;
      if (w && typeof w.utilization === "number") {
        windows.push({ kind, label, percent: clamp(w.utilization), resetsAt: toMs(w.resets_at) });
      }
    }
  }
  return { fetchedAt: now, windows };
}

function limitLabel(kind: string, model?: string): string {
  switch (kind) {
    case "session":
      return "5h";
    case "weekly_all":
      return "7d";
    case "weekly_scoped":
      return model ? `7d ${model}` : "7d model";
    default:
      return kind.replace(/_/g, " ");
  }
}

function planName(type?: string, tier?: string): string | undefined {
  const m = tier?.match(/max_(\d+x)/);
  if (m) {
    return `Max ${m[1]}`;
  }
  if (!type) {
    return undefined;
  }
  return type.replace(/^claude_/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
