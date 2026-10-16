# Changelog

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
