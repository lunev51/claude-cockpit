# Claude Cockpit

**A multi-project command center for [Claude Code](https://claude.com/claude-code).** One window, a tab per project, live session status, one-click morning restore — instead of ten terminal tabs, ten `cd`s and ten `/resume`s every day.

![Cockpit screenshot](docs/screenshot.png)

## Why

Claude Code is a terminal app. Run it across many projects and the terminal becomes the bottleneck: which tab is waiting for an answer? which one finished? how close am I to the 5-hour limit? Cockpit wraps real Claude Code sessions (true ConPTY terminals, not a re-implementation) in a purpose-built shell that answers those questions at a glance.

## Features

- **Tabs per project**, grouped by urgency in the sidebar: *waiting for you → working → done → trouble*. `Ctrl+1…9` to jump, `Ctrl+Tab` to cycle.
- **Live status from Claude Code hooks** — never from parsing terminal output. Six hook events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop) feed a per-tab status machine over a localhost bridge, with a generation guard so a late event from a killed process can't touch a fresh session.
- **Workspace restore** — reopen yesterday's tab set with `claude --resume <session>` per tab, staggered to avoid thundering-herd. Atomic manifest (temp+rename, `.bak`), ghost buffers preserve the last screen of dead sessions.
- **Prompt queue (`Ctrl+Q`)** — type your next prompts while Claude is busy; they're injected one per completed turn. Injection requires a *proven* pty generation — an outside process sharing the session id can move statuses, but can never type into your terminal.
- **Global history search (`Ctrl+Shift+H`)** — full-text search across every session transcript of every project, no SQLite, no native deps. Hit Enter on a result and the tab opens with *that* conversation resumed.
- **Prompt recipes & named workspaces (`Ctrl+P`)** — a library of parameterized prompts (`{{placeholder}}` → mini-form → terminal) and save/open-able tab sets, with confirmation before anything destructive.
- **Usage rings & spend dashboard (`Ctrl+D`)** — official OAuth usage endpoint for the 5-hour / weekly limit rings (with reset countdowns), [ccusage](https://github.com/ryoppippi/ccusage) for daily spend, per-project and per-model breakdowns.
- **Diff & GitHub panels (`Ctrl+G`)** — uncommitted changes with full diffs (untracked files included), PR badge with CI status on every tab, powered by `git` and the `gh` CLI. Read-only by design.
- **Toasts, taskbar badge, peek** — a Windows toast when a session needs you; `Space` on a waiting tab shows the exact question and lets you answer without switching.
- **Warp-inspired neutral-black design** — design tokens throughout, ANSI palette from [Warp's default dark theme](https://github.com/warpdotdev/themes) (MIT).

Press **⌨** in the action bar (or `Ctrl+P` → "Горячие клавиши") for the full hotkey cheat sheet.

## Architecture notes

- **Hooks, not scraping.** The only source of session state is Claude Code's own hook system. ANSI output is never parsed — statuses can't drift when the CLI changes its rendering.
- **Pure cores, injected edges.** Every data layer (`sessions`, `workspace`, `history-index`, `recipes`, `usage`, `git-info`, `gh-info`, `runners`) is a dependency-injected factory with no Electron imports — tested directly with `node --test`. **421 tests**, plus a smoke mode (`npm run smoke`) that boots the real window without spawning processes or touching user data.
- **Failure is a state, not an exception.** Missing `gh`, no git repo, expired OAuth token, corrupted cache — every layer degrades to an honest empty state and recovers on its own.
- **Process discipline.** Generation counters on every pty; helper process trees are cleaned up with a watchdog; killed sessions auto-respawn with their queue cleared.

Built in 7 phases with subagent-driven development: every task independently reviewed, every branch given a final whole-branch review before merge — the review pipeline caught 40+ real defects before they ever reached a user.

## Requirements

- **Windows 10/11** (ConPTY; Windows-first by design)
- **Node.js 20+**
- **[Claude Code](https://claude.com/claude-code)** installed and logged in
- Optional: [`gh` CLI](https://cli.github.com/) for the GitHub panel

## Run

```bash
git clone https://github.com/lunev51/claude-cockpit
cd claude-cockpit
npm install        # also fetches the node-pty prebuild for Electron 29
npm start
```

Add a project with **+ Проект**, then click **⚡** on the tab to write Cockpit's hooks into that project's `.claude/settings.json` — statuses go live from the next session. UI language is currently Russian.

```bash
npm test           # 421 unit tests (node --test)
npm run smoke      # boot check: window + pty + zero renderer errors
```

## License

[MIT](LICENSE). Not affiliated with Anthropic; Claude and Claude Code are Anthropic products.
