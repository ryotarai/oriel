# Oriel

A rich web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Run multiple Claude sessions side by side, review diffs and commits in real time, browse your project files, and pick up right where you left off -- all from a single browser tab.

<!-- TODO: Add screenshot -->

## Highlights

- **Live diff viewer** -- See every file change as Claude works, with syntax highlighting and line-by-line references
- **Parallel sessions** -- Run multiple Claude Code panes side by side, each with its own terminal and working directory
- **Reply suggestions** -- One-click follow-up suggestions appear after each response
- **Session resume** -- Pick up any previous conversation with one click; layout and context are fully restored
- **Readable conversation** -- Markdown rendering, inline agent results, syntax highlighting, and clickable file paths
- **File explorer & commit history** -- Browse code and review git commits without leaving the browser

## Quick Start

### Install

Download a pre-built binary from the [Releases](https://github.com/ryotarai/oriel/releases) page, or build from source:

```bash
git clone https://github.com/ryotarai/oriel.git
cd oriel
make build        # requires Go 1.24+ and Node.js 18+
# produces ./bin/oriel
```

**Prerequisite:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and available as `claude` in your PATH.

### Run

```bash
cd /path/to/your/project
oriel
```

The server starts, prints a URL with an auth token, and opens your browser automatically.

---

## Features

### Conversation View

Renders Claude's responses with full markdown, syntax-highlighted code blocks, expandable tool use/result details, and clickable file path links. Agent tool results are rendered as full markdown instead of collapsed blocks, so you can read sub-agent output inline. Select any text and press **r** to insert it as a quoted reply in the terminal.

### Reply Suggestions

After Claude finishes responding, Oriel automatically generates a handful of suggested follow-up messages. Click any suggestion to send it instantly -- no typing required. Great for common next steps like requesting tests, commits, or refinements.

### Tabbed Pane Views

Each pane has four switchable tabs -- **Conversation**, **Diff**, **Files**, and **Commits** -- so you can jump between Claude's output, file changes, the project tree, and git history without losing your place. Scroll positions are preserved across tab switches.

### Diff Viewer

Shows all file changes made during the session with per-file unified diffs and syntax highlighting. The Diff tab badge shows the number of changed files at a glance. Hover over any line to send a reference (`@path:line`) directly to Claude.

### File Explorer

Browse the working directory tree and view file contents with syntax highlighting. Like the diff viewer, every line has a one-click button to ask Claude about it.

### Commits

View recent git commits with full messages and diffs. Quickly review what Claude (or you) committed during the session.

### Multi-Tab, Multi-Pane Layout

Organize your work into tabs, each containing one or more Claude Code panes. Drag dividers to resize panes, drag tabs to reorder them, and double-click a tab to rename it. Each pane runs its own independent Claude session with its own working directory.

### Session Resume

Click the resume button in the toolbar to pick up a previous conversation. Oriel restores the terminal output, conversation history, and session context so you can continue exactly where you left off.

### Persistent Workspace

Your tab layout, pane sizes, working directories, and session associations are saved to a local SQLite database. Close the browser, restart the server -- everything is still there when you come back.

### Working Directory Per Pane

Each pane can target a different project directory. Click the folder icon in the toolbar to change it. Oriel also auto-detects when Claude enters a git worktree and updates the diff/files/commits views accordingly.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Enter** | Newline (multiline input) |
| **Cmd/Ctrl + Enter** | Submit to Claude |
| **Cmd/Ctrl + Arrow** | Move focus between panes |
| **r** (with text selected) | Quote-reply selected text in the terminal |

> Enter/Cmd+Enter behavior can be swapped in Settings.

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `-listen-addr` | `localhost:9111` | Address and port to listen on |
| `-command` | `claude` | CLI command to run in the terminal |
| `-no-open` | `false` | Don't auto-open the browser on startup |
| `-state-db` | `~/.config/oriel/state.sqlite3` | Path to the SQLite state database |

```bash
# Listen on a different port
oriel -listen-addr localhost:3000

# Use a specific Claude Code binary
oriel -command /usr/local/bin/claude

# Don't auto-open browser (useful for remote/SSH)
oriel -no-open
```

## Security

The server generates a random authentication token at startup. The token is included in the URL printed to the terminal and stored as an HTTP-only cookie after the first visit. Only users with the token can access the UI.

By default, the server listens on `localhost` only. To expose it on a network interface, change `-listen-addr` accordingly and be aware of the security implications.
