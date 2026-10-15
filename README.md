<p align="center"><img src="docs/images/hero.png" alt="AgentPool — many AI coding accounts, one VS Code" width="100%"></p>

<p align="center">
  <a href="https://github.com/TranHoaiHung/agent-pool/releases"><img alt="Release" src="https://img.shields.io/github/v/release/TranHoaiHung/agent-pool?label=release"></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-007ACC">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-supported-D97757">
  <img alt="Codex" src="https://img.shields.io/badge/Codex-supported-10A37F">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

# AgentPool — AI Account Switcher

Manage several **Claude Code** and **Codex** accounts in VS Code:

- **Hover** the status bar to see every account's quota (5-hour, weekly, per model) and reset times.
- **Switch** with one click from the tooltip, the editor title icon, the AgentPool view, or `AgentPool: Switch account`.
- **Priority order**: drag accounts in the AgentPool view (or use ↑/↓). Auto switch walks this order, e.g. B → A → C.
- **Auto switch** before the account in use runs out (default 95%), and back to a higher-priority account once it has room again.

## How it looks

### Quota of every account, on hover

<img src="docs/images/hover-tooltip.png" alt="Status bar tooltip listing each Claude Code account with 5-hour and weekly quota bars and Switch links" width="100%">

### Your priority order, by drag and drop

<img src="docs/images/priority-view.png" alt="AgentPool view in the Activity Bar: accounts grouped by tool, numbered by priority, one being dragged" width="100%">

### Auto switch before you hit the limit

<img src="docs/images/auto-switch.png" alt="Three steps: work at 78%, work hits 95% and switches to team, work resets and AgentPool goes back to it" width="100%">

### All tools, all accounts, one list

<img src="docs/images/quick-view.png" alt="Quick pick opened from the AgentPool icon in the editor title bar, listing Claude Code and Codex accounts with usage" width="100%">

## Quick start

1. Install AgentPool and reload the window.
2. Open the **AgentPool** view (Activity Bar) → **Save current login** for Claude Code and/or Codex.
3. **Add account** (＋) for each other account: it signs in through an isolated login, the account in use is untouched.
4. Drag accounts into the order you want. Done — hover the status bar to watch quotas.

## Claude Code: switch scope

<img src="docs/images/switch-scope.png" alt="Two options: VS Code only (default, terminal keeps its account) or switch terminal too (system Keychain login)" width="100%">

| Setting `agentPool.claude.switchTerminalToo` | What a switch changes |
|---|---|
| off (default) | Only Claude Code **inside VS Code**. It gets its own `CLAUDE_CONFIG_DIR` (`~/.agent-pool/claude-vscode`, Keychain item `Claude Code-credentials-<hash>`). `claude` in iTerm/Terminal keeps its account. |
| on | The system login (Keychain `Claude Code-credentials`): every `claude` in every terminal **and** VS Code. |

The VS Code slot links your `~/.claude` items (CLAUDE.md, agents, skills, commands, hooks, settings, plugins, projects…) so your config stays the same; only the login and `.claude.json` are separate. The first switch into the slot, and switching back to the terminal's account, need one window reload. Later switches are picked up by running sessions within ~35 s.

One login is never live in two slots: both would spend the same single-use refresh token.

## Codex

The login is `~/.codex/auth.json` (`CODEX_HOME` respected; only the `file` credential store is supported). A running Codex keeps its login until restarted, so a switch offers **Reload Window**; restart `codex` in terminals yourself.

## Adding accounts

- **Save current login**: saves the account the tool is signed in to now.
- **Add account (isolated login)**: runs `claude auth login` / `codex login` in a throwaway config folder, so the login in use is untouched.

Never use Claude's `/login` or **Log out**, or `codex login`/`codex logout` on the live config to add accounts: they replace or revoke the login in use.

## How it stays signed in

- Writes to Claude Code's slots take Claude Code's own `proper-lockfile` locks (`.oauth_refresh.lock`, `.storage-write.lock`) and re-read inside them.
- The outgoing login is always parked (saved) before anything overwrites it; a login nobody saved is enrolled automatically.
- Live logins are never renewed behind the owning tool's back; parked logins are renewed by AgentPool only.
- Only `claudeAiOauth` of Claude Code's credential document is swapped; MCP server tokens stay.

## Privacy

No telemetry, no server. Requests go only to Anthropic (`api.anthropic.com`, `platform.claude.com`) and OpenAI (`auth.openai.com`, `chatgpt.com`) for token renewal, identity and usage. Parked logins are kept in VS Code's encrypted SecretStorage; non-secret state in `~/.agent-pool/pool.json`.

The usage and OAuth endpoints are **unofficial** and may change. Manage only your own accounts and respect each provider's terms.

## Development

```sh
npm install
npm run typecheck && npm test
npm run build          # F5 "Run AgentPool" for an Extension Development Host
npm run package        # agent-pool-<version>.vsix
docs/screenshots-src/render.sh   # re-render README images (mockups with fictional data)
```

Ideas and measured facts from
[claude-account-switcher](https://github.com/KrzysztofZander/claude-account-switcher) (MIT) and
[pitboard](https://github.com/datlechin/pitboard) (Apache-2.0).
