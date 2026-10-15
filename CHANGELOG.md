# Changelog

## 0.1.1 — 2026-10-15

- Works right after install: the accounts you are signed in to are saved on first run.
- "Add account" no longer needs a CLI on PATH: uses the `claude` / `codex` bundled with the official extensions.
- Marketplace listing: AI category, clearer name and keywords.
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
