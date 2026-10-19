<p align="center"><img src="docs/images/hero.png" alt="AgentPool — many AI coding accounts, one VS Code" width="100%"></p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=TranHoaiHung.agent-pool"><img alt="Marketplace version" src="https://img.shields.io/visual-studio-marketplace/v/TranHoaiHung.agent-pool?label=Marketplace&color=007ACC"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=TranHoaiHung.agent-pool"><img alt="Installs" src="https://img.shields.io/visual-studio-marketplace/i/TranHoaiHung.agent-pool"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=TranHoaiHung.agent-pool&ssr=false#review-details"><img alt="Rating" src="https://img.shields.io/visual-studio-marketplace/r/TranHoaiHung.agent-pool"></a>
  <a href="https://github.com/TranHoaiHung/agent-pool"><img alt="GitHub stars" src="https://img.shields.io/github/stars/TranHoaiHung/agent-pool?style=flat"></a>
  <a href="https://github.com/TranHoaiHung/agent-pool/actions/workflows/ci.yml"><img alt="CI: Windows, Linux, macOS" src="https://github.com/TranHoaiHung/agent-pool/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-supported-D97757">
  <img alt="Codex" src="https://img.shields.io/badge/Codex-supported-10A37F">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

# AgentPool — AI Account Switcher

One account switcher for your Claude Code and Codex subscriptions, inside VS Code.

> If AgentPool saves you from a usage limit, please **[⭐ rate it on the Marketplace](https://marketplace.visualstudio.com/items?itemName=TranHoaiHung.agent-pool&ssr=false#review-details)** and **[star it on GitHub](https://github.com/TranHoaiHung/agent-pool)** — it helps other developers find it.

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

1. **Install** AgentPool. It saves the Claude Code / Codex accounts you are already signed in to, and the status bar shows their quota right away.
2. **Add account** (＋ in the AgentPool view, or the welcome message) for each other account. It signs in through an isolated login in a terminal + your browser; the account in use is untouched. No CLI to install: AgentPool uses the `claude` / `codex` that ships with the official extensions.
3. **Drag** accounts into the order you want — the order is saved immediately. Done — hover the status bar to watch quotas; auto switch handles the rest.

Signed in to another account later (`/login`, `codex login`)? AgentPool saves it on its own.

## Long sessions across organizations

Switching to an account in **another organization** means Claude cannot reuse its earlier thinking
("Claude can't use thinking from another organization") and rereads the whole conversation — slow and
costly on a long session. AgentPool keeps you in the **same conversation** (compact mode, default):

1. Near the limit (default 90% when switching at 95%), AgentPool asks you to run `/compact`:
   a **Compact now** button copies it and focuses Claude, and a reminder appears in the Claude panel
   after each reply.
2. Right after the compaction AgentPool switches accounts. The summary also gets your **latest
   requests verbatim**, the **files changed** and the current `git status`.
3. Keep typing in the same conversation: its first reply reads the short summary, not the whole history.

No compaction by the threshold? AgentPool switches anyway — the conversation still continues, its first
reply just rereads the history. Switching within one organization needs none of this.

Prefer a fresh conversation instead? Set `agentPool.claude.handoff.mode` to `newConversation`: Claude
writes a handoff and the next conversation starts from it.

It uses two official [Claude Code hooks](https://code.claude.com/docs/en/hooks) (Stop, SessionStart),
added to `~/.claude/settings.json` only after you agree once; your other hooks are left as they are.
Turn it off with `agentPool.claude.handoff.enabled` (the hooks are removed). The hooks read only local
files (the session transcript, `git status`); nothing is sent anywhere.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `agentPool.autoSwitch.thresholdPercent` | 95 | Switch away when the **5-hour** limit reaches this share (50–100). Also: `AgentPool: Set auto-switch threshold`, or click the % in the tooltip. |
| `agentPool.autoSwitch.weeklyThresholdPercent` | 98 | Same for **weekly / per-model** limits (never below the 5-hour one): 60% of a week still leaves plenty of room. |
| `agentPool.autoSwitch.enabled` | on | Auto switch on/off. |
| `agentPool.autoSaveLogins` | on | Save the account you sign in to automatically. |
| `agentPool.claude.pollIntervalSeconds` / `agentPool.codex.pollIntervalSeconds` | 300 | How often the account in use reads its quota (halved near the threshold). |
| `agentPool.idlePollMinutes` | 30 | How often accounts not in use read their quota. |
| `agentPool.claude.handoff.enabled` / `.marginPercent` | on / 5 | Long-session help when switching to another organization, starting this many points before the threshold. |
| `agentPool.claude.handoff.mode` | compact | `compact` (same conversation, /compact before the switch) or `newConversation`. |
| `agentPool.claude.handoff.newConversation` | off | newConversation mode only: `ask` (button) or `auto`. |
| `agentPool.claude.switchTerminalToo` | off | Switch the terminal's `claude` too (see below). |

To remove an account: 🗑 on its row in the AgentPool view or in the quick view, or `AgentPool: Remove account`.

## Claude Code: switch scope

<img src="docs/images/switch-scope.png" alt="Two options: VS Code only (default, terminal keeps its account) or switch terminal too (system Keychain login)" width="100%">

| Setting `agentPool.claude.switchTerminalToo` | What a switch changes |
|---|---|
| off (default) | Only Claude Code **inside VS Code**. It gets its own `CLAUDE_CONFIG_DIR` (`~/.agent-pool/claude-vscode`, Keychain item `Claude Code-credentials-<hash>`). `claude` in iTerm/Terminal keeps its account. |
| on | The system login (Keychain `Claude Code-credentials`): every `claude` in every terminal **and** VS Code. |

The VS Code slot links your `~/.claude` items (CLAUDE.md, agents, skills, commands, hooks, settings, plugins, projects…) so your config stays the same; only the login and `.claude.json` are separate. The first switch into the slot, and switching back to the terminal's account, need one window reload. Later switches are picked up by running sessions within ~35 s.

When VS Code and the terminal use the same account, AgentPool keeps their two copies of the login on
one generation (it renews early and copies any newer token across), since a refresh token can only be
used once.

**Choose the terminal's account:** right-click it → *Use for terminal (pin)*. VS Code switches never
move the terminal, and VS Code can still use that same account — AgentPool keeps both copies of the
login in sync.

**Windows and Linux:** Claude Code keeps its login in `.credentials.json` instead of the Keychain; AgentPool switches that file the same way. On Windows, shared folders are linked as junctions (no admin rights or Developer Mode needed) and shared files as hard links or refreshed copies.

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

## Support the project

AgentPool is free and open source. The best ways to help:

- ⭐ **[Rate it on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=TranHoaiHung.agent-pool&ssr=false#review-details)**
- 🌟 **[Star the repo on GitHub](https://github.com/TranHoaiHung/agent-pool)**
- 🐞 **[Report a bug or ask for a feature](https://github.com/TranHoaiHung/agent-pool/issues)**

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
