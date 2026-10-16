# Changelog

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
