# Changelog

## 0.2.0 — 2026-10-19

- **Account groups**: run company and personal projects side by side. Assign each workspace to a group
  (*AgentPool: Account group for this workspace…*) — e.g. *Company* for projects A, B, C, the default
  group for the rest — and every VS Code window runs Claude Code on its own group's account at the
  same time. Each group has its own login slot, priority order and auto switch (never crossing into
  another group), and a group's window shows only its own Claude accounts.
- Groups other than the default one are **isolated**: they share only `agents`, `commands` and `skills`
  from `~/.claude` (setting `agentPool.claude.groupSharedItems`) — no global `CLAUDE.md`, hooks,
  project history, memory or MCP servers — so personal instructions and history never reach a
  company session. `claude` in a group window's integrated terminal uses the group's account.
- Pick a group's accounts with ticks right after choosing the group, or later with *Choose accounts of a
  group…* (right-click **Claude Code**); select several accounts (Cmd/Ctrl-click) → *Move to account
  group…*. A login signed in from a group's window joins that group.
- The view's first row shows the workspace's group: click it to change the group, ☑ to pick the
  group's accounts. While a window must reload it turns into **Reload window to use …** (one click),
  a reload button appears in the view's title bar, and clicking the status bar item reloads too.
- Without groups nothing changes.

## 0.1.16 — 2026-10-19

- **VS Code can use the terminal's account too.** Picking the account the terminal uses no longer
  asks to swap or refuses a pinned account: both keep it, and AgentPool keeps the two copies of the
  login on one generation (it renews early, holding both locks, and copies any newer token across
  every minute), so neither side is ever signed out.
- The terminal is never moved by VS Code switches anymore — no swap, and unpinning changes nothing
  but the pin. "Use for terminal (pin)" simply sets the terminal's account.

## 0.1.15 — 2026-10-18

- Fix: an old VS Code window that had not reloaded after the one-time slot setup blocked auto switch
  for every window, so the account in use ran from 94% to 100% and Claude stopped until a reload.
  Auto switch now always happens at the threshold; only a window that really still runs the old
  setup is asked to reload (it is detected exactly — by the slot setting it started with — instead
  of by time, so windows are no longer flagged after ordinary switches).

## 0.1.14 — 2026-10-17

- **Pin an account to the terminal** (Claude Code): right-click an account → *Use for terminal (pin)*.
  Every `claude` you run in a terminal uses it, and nothing done in VS Code — auto switch, manual
  switch, swap, "switch terminal too" — ever changes it. The pinned account is marked "📌 terminal"
  and is never used by VS Code. *AgentPool: Unpin terminal account* releases it.

## 0.1.13 — 2026-10-16

- Weekly and per-model limits now switch at **98%** by default (was 95%): the threshold you set is for
  the 5-hour limit; `agentPool.autoSwitch.weeklyThresholdPercent` stays available for those who want
  to spread weekly use earlier.

## 0.1.12 — 2026-10-16

- Fix: with a low threshold (e.g. 50%), auto switch stayed on an account at 80% because the other
  account's **weekly** use (60%) was also compared with 50%. Thresholds now apply per kind of limit:
  the one you set is for the **5-hour** limit; weekly and per-model limits use
  `agentPool.autoSwitch.weeklyThresholdPercent` (default 95, never below the 5-hour one). An account
  at 5h 25% / 7d 60% is a good target at a 50% threshold, and staying on it raises no warning.
- When no account is under the thresholds, AgentPool moves to the one with clearly more room
  (at least 10 points less used) instead of running the current one to 100%; similar accounts never
  trade places.
- When AgentPool stays put, the tooltip says why; the tooltip shows both thresholds.

## 0.1.11 — 2026-10-16

- Fix: auto switch could stay blocked while a window waited for a reload it never got (status bar
  "⟳"), letting the account reach 100%. When a switch is due in such a window, AgentPool now asks
  to reload in a dialog (at most every 10 minutes), or reloads by itself with
  `agentPool.autoReloadAfterSwitch`; the status bar says "reload" next to the ⟳.

## 0.1.10 — 2026-10-16

- Fix: after a switch, Claude Code in VS Code could keep using the previous account (and its quota)
  while the Account panel showed the new one, whenever the window was not reloaded. The VS Code slot
  now needs **one reload, once**: after that it stays on and every switch is picked up by running
  sessions without any reload. The one-time reload is asked in a dialog, not a toast.
- The terminal's account (VS Code only mode) is marked "in terminal" and skipped by auto switch —
  one login cannot run in two places. Choosing it by hand offers to **swap** the two accounts.
- The account shown by `/status` is updated reliably (retried while Claude Code writes its config),
  and the previous account's cached usage numbers are always cleared.

## 0.1.9 — 2026-10-16

- **Accounts save themselves:** when you sign in to another Claude Code or Codex account
  (`/login`, `codex login`, …), AgentPool saves it automatically — no "Save current login" needed.
  An account you remove is not saved again until you save it yourself. Setting: `agentPool.autoSaveLogins`.
- Reordering (drag & drop, ↑/↓) confirms "priority order saved" — it is stored the moment it changes.
- The AgentPool version is shown in the view title and the tooltip footer (and logged), to help support.

## 0.1.8 — 2026-10-16

- **Compact mode** (new default, `agentPool.claude.handoff.mode`): near the limit (default 90%)
  AgentPool asks you to run `/compact` — a "Compact now" button copies it and focuses Claude, and a
  reminder line appears in the Claude panel after each reply. Right after the compaction AgentPool
  switches accounts and **the same conversation continues** from its summary, which also gets your
  latest requests verbatim, the files changed and `git status`. Without a compaction, the switch
  still happens at the threshold — nothing waits.
- No new conversations are opened unless you choose `newConversation` mode
  (`agentPool.claude.handoff.newConversation` now defaults to `off`).

## 0.1.7 — 2026-10-16

- Smarter handoff for long sessions: besides Claude's summary (now also conventions agreed and
  pitfalls already hit), the hook attaches your latest requests **verbatim** and the files changed,
  read from the session transcript; the new conversation also gets the current `git status` and
  recent commits, so work done after the handoff is not missed.
- Handoff only when switching to another organization (within one, Claude keeps its thinking).
- The switch waits for the handoff (up to 5 minutes, never past 99%) so a long turn cannot skip it.
- After the switch: a "New conversation" button (`agentPool.claude.handoff.newConversation`:
  `ask` by default, `auto`, or `off`) opens a Claude conversation that starts from the handoff.

## 0.1.6 — 2026-10-16

- **Handoff between Claude accounts.** A few points before the auto switch (default 90% when
  switching at 95%), Claude writes a short handoff of the work in progress — goal, progress, exact
  next step, decisions, how to verify. The next conversation on the new account starts from it,
  without rereading the whole old conversation. Uses two official Claude Code hooks (Stop,
  SessionStart) added to `~/.claude/settings.json` after you agree once; your other hooks stay
  untouched. Settings: `agentPool.claude.handoff.enabled`, `agentPool.claude.handoff.marginPercent`.

## 0.1.5 — 2026-10-15

- Works in Cursor, Windsurf, VSCodium, VS Code Insiders and remote servers: the bundled
  `claude`/`codex` are found in the running editor's own extensions folder.
- Windows: "Add account" picks npm's `claude.cmd` (or an .exe) instead of the extensionless
  script that Windows cannot launch.
- Tested on Windows, Linux and macOS in CI on every change.

## 0.1.4 — 2026-10-15

- Fix "Add account" failing with exit code 127 when `claude` on PATH is npm's Node script and
  VS Code (started from the Dock) has no `node` on its PATH. AgentPool now prefers the
  self-contained binary bundled with the official Claude Code / Codex extensions, and runs any
  script launcher from your login shell so your PATH (nvm, Homebrew) applies.

## 0.1.3 — 2026-10-15

- Windows: no more `EPERM … symlink` when switching Claude Code in VS Code only. Shared folders
  of `~/.claude` become junctions (no admin rights needed); shared files fall back to a hard link
  or a copy that is refreshed when the original changes. One item that cannot be shared no longer
  stops the switch.
- Windows: "Add account" finds `claude`/`codex` with `where.exe` and runs the sign-in without a
  shell, so it works in PowerShell and cmd (and with npm's `claude.cmd`).
- Windows: file replacements retry briefly while another program has the file open.

## 0.1.2 — 2026-10-15

- Lighter on your machine: checks once a minute instead of every 15 s; the account in use reads
  its quota every 5 min (2 min near the threshold), idle accounts every 30 min and right before a switch;
  Keychain lookups are cached briefly.
- Remove accounts from the AgentPool view (🗑 on each row), the quick view, or `AgentPool: Remove account`.
- Auto switch threshold from 50 to 100% (default 95): `AgentPool: Set auto-switch threshold`, or click the % in the tooltip.

## 0.1.1 — 2026-10-15

- Works right after install: the accounts you are signed in to are saved on first run.
- "Add account" no longer needs a CLI on PATH: uses the `claude` / `codex` bundled with the official extensions.
- Marketplace listing: AI category, clearer description and keywords.
- An optional, at-most-twice rating prompt after AgentPool has been useful for a few days.

## 0.1.0 — 2026-10-15

- Claude Code and Codex accounts: save current login, add accounts through an isolated login.
- Status bar per tool with every account's quota (5-hour, weekly, per model) in the hover tooltip.
- One-click switching from the tooltip, the AgentPool view and the command palette; undo.
- Editor title icon: every account of every tool in one quick list.
- Priority order by drag and drop; auto switch at a threshold (default 95%) following that order,
  and back to a higher-priority account once it has room.
- Claude Code switch scope: VS Code only (own `CLAUDE_CONFIG_DIR` slot, default) or the system
  Keychain login used by every terminal.
- Safe token handling: Claude Code's own locks, park-before-overwrite, cross-window account locks,
  single leader window for polling and auto switch.
- Windows that still run the previous account are flagged until reloaded; auto switch waits for them.
