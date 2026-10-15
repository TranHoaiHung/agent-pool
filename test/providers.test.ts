import { describe, expect, it } from "vitest";
import { isExpiring, parseClaudeUsage } from "../src/providers/claude/claude-api";
import { dirHash, serviceForDir } from "../src/providers/claude/claude-paths";
import { addCommand } from "../src/providers/claude/keychain";
import { codexIdentity, isCodexTokenExpiring, parseCodexUsage, windowLabel } from "../src/providers/codex/codex-api";

const NOW = Date.parse("2026-10-15T01:30:00Z");

describe("claude slot naming", () => {
  // Vectors measured by pitboard on a real machine: Claude Code created these Keychain items.
  it("matches measured Keychain suffixes", () => {
    expect(dirHash("/Users/ngoquocdat/.claude")).toBe("e80beed8");
    expect(
      dirHash("/private/tmp/claude-501/-Users-ngoquocdat/32ac806a-a8b6-4258-8ba1-548995f8d827/scratchpad/m0/s1")
    ).toBe("a4bc5512");
    expect(serviceForDir("/x")).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  it("builds Claude Code's security -i command with a hex value", () => {
    const cmd = addCommand("me", "Claude Code-credentials", '{"a":1}');
    expect(cmd).toBe(`add-generic-password -U -a me -s "Claude Code-credentials" -X ${Buffer.from('{"a":1}').toString("hex")}\n`);
  });
});

describe("claude usage", () => {
  it("parses the limits list of a live answer (shape read 2026-10-15)", () => {
    const snap = parseClaudeUsage(
      {
        five_hour: { utilization: 7, resets_at: "2026-10-15T04:40:00.104148+00:00" },
        limits: [
          { kind: "session", percent: 7, resets_at: "2026-10-15T04:40:00.104148+00:00" },
          { kind: "weekly_all", percent: 41, resets_at: "2026-10-19T03:00:00.104168+00:00" },
          { kind: "weekly_scoped", percent: 0, resets_at: "2026-10-19T03:00:00+00:00", scope: { model: { display_name: "Fable" } } },
        ],
      },
      NOW
    );
    expect(snap.windows.map((w) => [w.label, w.percent])).toEqual([["5h", 7], ["7d", 41], ["7d Fable", 0]]);
    expect(snap.windows[0].resetsAt).toBe(Date.parse("2026-10-15T04:40:00.104Z"));
  });

  it("falls back to named windows and tolerates nulls", () => {
    const snap = parseClaudeUsage({ five_hour: { utilization: 50.4, resets_at: null }, seven_day: null }, NOW);
    expect(snap.windows).toEqual([{ kind: "session", label: "5h", percent: 50, resetsAt: null }]);
  });

  it("treats a login within 5 minutes of expiry as expiring", () => {
    expect(isExpiring({ accessToken: "a", refreshToken: "r", expiresAt: NOW + 4 * 60_000 }, NOW)).toBe(true);
    expect(isExpiring({ accessToken: "a", refreshToken: "r", expiresAt: NOW + 60 * 60_000 }, NOW)).toBe(false);
  });
});

function jwt(payload: object): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

describe("codex", () => {
  it("identifies a login from its ID token without the network", () => {
    const id = codexIdentity({
      tokens: {
        id_token: jwt({ email: "a@b.c", "https://api.openai.com/auth": { chatgpt_account_id: "acc", chatgpt_user_id: "usr", chatgpt_plan_type: "plus" } }),
        access_token: "t",
        refresh_token: "r",
      },
    });
    expect(id).toEqual({ identityKey: "usr:acc", email: "a@b.c", plan: "Plus" });
  });

  it("reads token expiry from the access token", () => {
    const auth = (exp: number) => ({ tokens: { id_token: "", access_token: jwt({ exp }), refresh_token: "r" } });
    expect(isCodexTokenExpiring(auth(NOW / 1000 + 60), NOW)).toBe(true);
    expect(isCodexTokenExpiring(auth(NOW / 1000 + 86_400), NOW)).toBe(false);
  });

  it("parses windows by their length, from a live answer's shape", () => {
    const snap = parseCodexUsage(
      {
        plan_type: "pro",
        rate_limit: {
          limit_reached: false,
          primary_window: { used_percent: 12.5, limit_window_seconds: 18_000, reset_at: 1_790_100_000 },
          secondary_window: { used_percent: 45, limit_window_seconds: 604_800, reset_at: 1_790_628_078 },
        },
      },
      NOW
    );
    expect(snap.windows.map((w) => [w.label, w.percent])).toEqual([["5h", 13], ["7d", 45]]);
    expect(snap.plan).toBe("Pro");
    expect(parseCodexUsage({ rate_limit: null }, NOW).windows).toEqual([]);
    expect(windowLabel(2_592_000)).toBe("30d");
  });
});
