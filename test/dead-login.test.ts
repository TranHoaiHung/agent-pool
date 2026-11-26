import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { AccountService, reauthText } from "../src/account-service";
import { PoolStore } from "../src/core/pool-store";
import { AccountSecret } from "../src/core/types";
import { HttpError } from "../src/providers/http";

describe("dead logins", () => {
  it("tells an organization's block apart from a spent refresh token", () => {
    const blocked = new HttpError(403, 'HTTP 403: {"error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}');
    expect(blocked.orgBlocked).toBe(true);
    expect(blocked.deadLogin).toBe(false);
    const spent = new HttpError(400, 'HTTP 400: {"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}');
    expect(spent.deadLogin).toBe(true);
    expect(spent.orgBlocked).toBe(false);
    expect(new HttpError(403, "HTTP 403: forbidden").orgBlocked).toBe(false);
  });

  it("never switches to an account whose login stopped working", async () => {
    const pool = new PoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ap-dead-")), "pool.json"));
    const secrets = new Map<string, AccountSecret>();
    const vault = {
      get: async (id: string) => secrets.get(id),
      set: async (id: string, s: AccountSecret) => void secrets.set(id, s),
      delete: async (id: string) => void secrets.delete(id),
    };
    const service = new AccountService(pool, vault, () => undefined);
    let switched = 0;
    service.register({ id: "claude", invalidate: () => undefined, switchTo: async () => (switched++, { needsReload: false, notes: [] }) } as never);
    const meta = await service.enroll("claude", { kind: "claude", oauth: { accessToken: "a", refreshToken: "r" } }, { identityKey: "u1:org1" });
    await service.update(meta.id, (a) => {
      a.needsReauth = true;
      a.reauthReason = "organization blocks Claude Code sign-in";
    });
    await expect(service.switchTo(meta.id, false)).rejects.toThrow(/organization blocks/);
    expect(switched).toBe(0);
    expect(reauthText(service.account(meta.id)!)).toBe("organization blocks Claude Code sign-in");
    // Signing in again clears it.
    await service.enroll("claude", { kind: "claude", oauth: { accessToken: "b", refreshToken: "s" } }, { identityKey: "u1:org1" });
    expect(service.account(meta.id)?.needsReauth).toBe(false);
    expect(service.account(meta.id)?.reauthReason).toBeUndefined();
  });
});
