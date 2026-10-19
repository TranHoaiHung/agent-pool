import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/account-service";
import { DEFAULT_GROUP, groupForWorkspace, groupsOn, laneKey, newGroupId } from "../src/core/groups";
import { PoolStore } from "../src/core/pool-store";
import { move, ordered, placeBefore } from "../src/core/priority";
import { AccountMeta, AccountSecret, emptyPool, PoolData } from "../src/core/types";
import { globalSlot, groupSlotDir, launchConfigDir, setWindowConfigDir, vscodeSlotDir } from "../src/providers/claude/claude-paths";
import { linkProjectHistory, projectDirName } from "../src/providers/claude/project-history";

function account(id: string, group?: string, provider: "claude" | "codex" = "claude"): AccountMeta {
  return { id, provider, label: id, identityKey: `${id}:org`, inRotation: true, addedAt: 0, group };
}

function pool(accounts: AccountMeta[]): PoolData {
  const data = emptyPool();
  data.accounts = accounts;
  data.order.claude = accounts.filter((a) => a.provider === "claude").map((a) => a.id);
  data.groups = [{ id: "work", name: "Work" }];
  return data;
}

describe("account groups (pure)", () => {
  it("assigns workspaces, falling back to the default group when unassigned or the group is gone", () => {
    const data = pool([]);
    data.workspaceGroups = { "/src/a": "work", "/src/old": "gone" };
    expect(groupForWorkspace(data, "/src/a")).toBe("work");
    expect(groupForWorkspace(data, "/src/d")).toBe(DEFAULT_GROUP);
    expect(groupForWorkspace(data, "/src/old")).toBe(DEFAULT_GROUP);
    expect(groupForWorkspace(data, undefined)).toBe(DEFAULT_GROUP);
    expect(groupsOn(data)).toBe(true);
    expect(groupsOn(emptyPool())).toBe(false);
  });

  it("keeps the default group's pool keys and gives other groups their own", () => {
    expect(laneKey("claude", DEFAULT_GROUP)).toBe("claude");
    expect(laneKey("codex", "work")).toBe("codex");
    expect(laneKey("claude", "work")).toBe("claude@work");
  });

  it("makes folder-safe, unique group ids", () => {
    const data = pool([]);
    expect(newGroupId("Công ty Đông Á", data)).toBe("cong-ty-dong-a");
    expect(newGroupId("Work", data)).toBe("work-2");
    expect(newGroupId("default", data)).toBe("default-2");
    expect(newGroupId("!!!", data)).toBe("group");
  });

  it("each group sees only its own Claude accounts, and every group sees Codex", () => {
    const data = pool([account("p1"), account("w1", "work"), account("p2"), account("w2", "work"), account("c1", undefined, "codex")]);
    data.order.codex = ["c1"];
    expect(ordered(data, "claude", DEFAULT_GROUP).map((a) => a.id)).toEqual(["p1", "p2"]);
    expect(ordered(data, "claude", "work").map((a) => a.id)).toEqual(["w1", "w2"]);
    expect(ordered(data, "codex", "work").map((a) => a.id)).toEqual(["c1"]);
    expect(ordered(data, "claude").map((a) => a.id)).toEqual(["p1", "w1", "p2", "w2"]);
  });

  it("reorders within a group without moving another group's accounts", () => {
    const data = pool([account("p1"), account("w1", "work"), account("p2"), account("w2", "work")]);
    move(data, "w2", -1, "work");
    expect(data.order.claude).toEqual(["p1", "w2", "p2", "w1"]);
    placeBefore(data, "p2", "p1", DEFAULT_GROUP);
    expect(data.order.claude).toEqual(["p2", "w2", "p1", "w1"]);
    // An account the group does not see is left alone.
    move(data, "p1", -5, "work");
    placeBefore(data, "w1", undefined, DEFAULT_GROUP);
    expect(data.order.claude).toEqual(["p2", "w2", "p1", "w1"]);
  });
});

describe("account groups (service)", () => {
  function setup(group: string, groupOwner: (g: string) => string | undefined = () => undefined) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ap-groups-")), "pool.json");
    const store = new PoolStore(file);
    const secrets = new Map<string, AccountSecret>();
    const vault = {
      get: async (id: string) => secrets.get(id),
      set: async (id: string, s: AccountSecret) => void secrets.set(id, s),
      delete: async (id: string) => void secrets.delete(id),
    };
    const service = new AccountService(store, vault, () => undefined);
    service.group = group;
    service.register({ id: "claude", invalidate: () => undefined, groupOwner: async (g: string) => groupOwner(g) } as never);
    return { store, service };
  }
  const login: AccountSecret = { kind: "claude", oauth: { accessToken: "a", refreshToken: "r" } };

  it("a login saved from a group's window joins that group; the default group leaves it unset", async () => {
    const work = setup("work");
    const meta = await work.service.enroll("claude", login, { identityKey: "u1:org1", email: "dev@acme.io" });
    expect(meta.group).toBe("work");
    const codex = await work.service.enroll("codex", { kind: "codex", auth: {} }, { identityKey: "c:1" });
    expect(codex.group).toBeUndefined();
    const personal = setup(DEFAULT_GROUP);
    expect((await personal.service.enroll("claude", login, { identityKey: "u2:org2" })).group).toBeUndefined();
  });

  it("creates groups, assigns workspaces, and moves parked accounts between groups", async () => {
    const { store, service } = setup(DEFAULT_GROUP);
    const id = await service.createGroup("Company");
    expect(id).toBe("company");
    await service.setWorkspaceGroup("/src/a", id);
    expect(groupForWorkspace(store.get(), "/src/a")).toBe("company");
    await service.setWorkspaceGroup("/src/a", DEFAULT_GROUP);
    expect(store.get().workspaceGroups).toEqual({});

    const meta = await service.enroll("claude", login, { identityKey: "u1:org1" });
    await service.moveToGroup(meta.id, id);
    expect(service.account(meta.id)?.group).toBe("company");
    expect(service.accounts().map((a) => a.id)).toEqual([]); // no longer seen by the default group
    await service.moveToGroup(meta.id, DEFAULT_GROUP);
    expect(service.account(meta.id)?.group).toBeUndefined();
  });

  it("a login parked from the terminal joins the default group even from a group's window", async () => {
    const { service } = setup("work");
    const meta = await service.providerContext().enroll("claude", login, { identityKey: "u9:org9" }, DEFAULT_GROUP);
    expect(meta.group).toBeUndefined();
  });

  it("refuses to move an account any other group's slot holds", async () => {
    let live: string | undefined;
    const { service } = setup(DEFAULT_GROUP, (g) => (g === "company" ? live : undefined));
    await service.createGroup("Company");
    await service.createGroup("Lab");
    const meta = await service.enroll("claude", login, { identityKey: "u1:org1" });
    live = meta.id; // e.g. a /login in a Company window with this account
    await expect(service.moveToGroup(meta.id, "lab")).rejects.toThrow(/in use by the Company group/);
    await service.moveToGroup(meta.id, "company"); // already live there: joining it is fine
    expect(service.account(meta.id)?.group).toBe("company");
  });

  it("refuses to move an account its group's slot holds (one login, two slots)", async () => {
    let live: string | undefined;
    const { service } = setup(DEFAULT_GROUP, (g) => (g === DEFAULT_GROUP ? live : undefined));
    await service.createGroup("Company");
    const meta = await service.enroll("claude", login, { identityKey: "u1:org1" });
    live = meta.id;
    await expect(service.moveToGroup(meta.id, "company")).rejects.toThrow(/in use by the Default group/);
    expect(service.account(meta.id)?.group).toBeUndefined();
  });
});

describe("per-window CLAUDE_CONFIG_DIR", () => {
  const original = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    setWindowConfigDir(undefined);
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
  });

  it("sets the window's slot for Claude Code while the terminal's login stays the launch one", () => {
    const before = globalSlot();
    setWindowConfigDir(groupSlotDir("work"));
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(groupSlotDir("work"));
    expect(globalSlot()).toEqual(before);
    expect(launchConfigDir()).toBe(original);
    setWindowConfigDir(undefined);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(original);
  });

  it("keeps the default group on the original VS Code slot", () => {
    expect(groupSlotDir(DEFAULT_GROUP)).toBe(vscodeSlotDir());
    expect(path.basename(groupSlotDir("work"))).toBe("claude-group-work");
  });
});

describe("a group's view of its workspace history", () => {
  it("names project folders like Claude Code, long paths included", () => {
    expect(projectDirName("/Users/dev/src/acme_kit-flutter")).toBe("-Users-dev-src-acme-kit-flutter");
    const long = `/Users/dev/${"very-long-folder/".repeat(15)}app`;
    const name = projectDirName(long);
    expect(name.length).toBeGreaterThan(200);
    expect(name.slice(0, 201)).toBe(`${long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-`);
  });

  it("links only the workspace's own history, moving what the group already wrote", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-hist-"));
    const shared = path.join(root, "claude", "projects");
    const slot = path.join(root, "slot");
    const ws = "/Users/dev/src/acme-api";
    const name = projectDirName(ws);
    fs.mkdirSync(path.join(shared, name), { recursive: true });
    fs.writeFileSync(path.join(shared, name, "old.jsonl"), "before");
    fs.mkdirSync(path.join(shared, "-Users-dev-src-my-blog"), { recursive: true });
    fs.mkdirSync(path.join(slot, "projects", name), { recursive: true });
    fs.writeFileSync(path.join(slot, "projects", name, "new.jsonl"), "in group");

    linkProjectHistory(shared, slot, [ws], () => undefined);

    expect(fs.lstatSync(path.join(slot, "projects", name)).isSymbolicLink() || process.platform === "win32").toBe(true);
    expect(fs.readdirSync(path.join(slot, "projects", name)).sort()).toEqual(["new.jsonl", "old.jsonl"]);
    expect(fs.readdirSync(path.join(slot, "projects"))).toEqual([name]); // no personal project
    linkProjectHistory(shared, slot, [ws], () => undefined); // idempotent
    expect(fs.readFileSync(path.join(shared, name, "new.jsonl"), "utf8")).toBe("in group");
  });
});
