import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { AccountService } from "../src/account-service";
import { PoolStore } from "../src/core/pool-store";
import { move, ordered } from "../src/core/priority";
import { AccountSecret, Identity } from "../src/core/types";

function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ap-auto-")), "pool.json");
  const pool = new PoolStore(file);
  const secrets = new Map<string, AccountSecret>();
  const vault = {
    get: async (id: string) => secrets.get(id),
    set: async (id: string, s: AccountSecret) => void secrets.set(id, s),
    delete: async (id: string) => void secrets.delete(id),
  };
  const service = new AccountService(pool, vault, () => undefined);
  let current: { secret: AccountSecret; identity: Identity } | undefined = {
    secret: { kind: "claude", oauth: { accessToken: "a", refreshToken: "r" } },
    identity: { identityKey: "u1:org1", email: "dev@acme.io" },
  };
  // The fake tool reports the login in use only once it is saved (like the real providers).
  service.register({
    id: "claude",
    activeAccountId: async () => pool.get().accounts.find((a) => a.identityKey === current?.identity.identityKey)?.id,
    captureCurrent: async () => current,
    invalidate: () => undefined,
  } as never);
  service.register({ id: "codex", activeAccountId: async () => undefined, captureCurrent: async () => undefined, invalidate: () => undefined } as never);
  return { pool, service, file, setLogin: (c: typeof current) => (current = c) };
}

describe("auto-save of the login in use", () => {
  it("saves a login nobody saved, once, and makes it the active one", async () => {
    const { pool, service } = setup();
    const saved: string[] = [];
    service.onAutoSaved((m) => saved.push(m.email!));
    await service.refreshActive();
    expect(pool.get().accounts.map((a) => a.email)).toEqual(["dev@acme.io"]);
    expect(service.activeId("claude")).toBe(pool.get().accounts[0].id);
    await service.refreshActive();
    expect(saved).toEqual(["dev@acme.io"]);
  });

  it("does not bring back an account the person removed, until saved by hand", async () => {
    const { pool, service } = setup();
    await service.refreshActive();
    await service.remove(pool.get().accounts[0].id);
    (service as unknown as { autoSaveTried: Map<string, number> }).autoSaveTried.clear();
    await service.refreshActive();
    expect(pool.get().accounts).toHaveLength(0);
    await service.saveCurrent("claude");
    expect(pool.get().accounts).toHaveLength(1);
    expect(pool.get().removedIdentities).toEqual([]);
  });

  it("can be turned off", async () => {
    const { pool, service } = setup();
    service.settings = { autoSaveLogins: () => false };
    await service.refreshActive();
    expect(pool.get().accounts).toHaveLength(0);
  });
});

describe("priority order", () => {
  it("is on disk the moment it changes (no save step)", async () => {
    const { pool, service, file, setLogin } = setup();
    await service.refreshActive();
    setLogin({ secret: { kind: "claude", oauth: { accessToken: "b", refreshToken: "s" } }, identity: { identityKey: "u2:org2", email: "two@acme.io" } });
    (service as unknown as { autoSaveTried: Map<string, number> }).autoSaveTried.clear();
    await service.refreshActive();
    const [first, second] = ordered(pool.get(), "claude").map((a) => a.id);
    await pool.mutate((d) => move(d, second, -1));
    const reread = new PoolStore(file);
    expect(ordered(reread.get(), "claude").map((a) => a.id)).toEqual([second, first]);
  });
});
