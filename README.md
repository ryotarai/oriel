# Claude Code Wrapper UI

A web-based interface that wraps [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, adding a conversation viewer, diff inspector, and file explorer alongside the terminal.

![Diff Tab](screenshot-diff-tab.png)

## Features

- **Conversation view** -- Renders Claude's responses with syntax-highlighted code blocks, tool use/result details, and clickable file path links
- **Diff viewer** -- Shows all file changes made during the session with per-file unified diffs and syntax highlighting
- **File explorer** -- Browse the working directory tree and view file contents; click file paths in the conversation to jump directly to them
- **Multi-pane layout** -- Split the window into multiple independent Claude Code sessions with draggable dividers
- **Session resume** -- Type `/resume` in the terminal to pick up a previous conversation

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and available as `claude` in your PATH
- [Go](https://go.dev/) 1.24+ (to build from source)
- [Node.js](https://nodejs.org/) 18+ and npm (to build the frontend)

## Installation

```bash
git clone https://github.com/ryotarai/claude-code-wrapper-ui.git
cd claude-code-wrapper-ui
make build
```

This produces a single binary at `./bin/server` with the frontend assets embedded.

### Cross-platform builds

```bash
make build-all   # builds for linux/darwin × amd64/arm64 under bin/
```

## Usage

Run the server from the directory where you want Claude Code to operate:

```bash
cd /path/to/your/project
/path/to/bin/server
```

The server starts, prints a URL with an auth token, and opens your browser automatically.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-listen-addr` | `localhost:9111` | Address and port to listen on |
| `-command` | `claude` | CLI command to run in the terminal |
| `-no-open` | `false` | Don't auto-open the browser on startup |

### Examples

```bash
# Listen on a different port
./bin/server -listen-addr localhost:3000

# Use a specific Claude Code binary
./bin/server -command /usr/local/bin/claude

# Don't auto-open browser (useful for remote/SSH)
./bin/server -no-open
```

## Interface

The UI has three tabs above the terminal:

- **Conversation** -- Shows the parsed conversation between you and Claude with markdown rendering, syntax highlighting, and expandable tool use blocks
- **Diff** -- Lists changed files with their diffs since the session started; click a file in the sidebar to scroll to its diff
- **Files** -- Lets you browse the project directory tree and view file contents

Click the **+** button in the top-right corner to add a new pane. Drag the divider between panes to resize them.

### Keyboard shortcuts

- **Enter** in Claude's input prompt sends as `Ctrl+J` (allowing multiline input without submitting)
- Select text in the conversation and press **r** to insert it as a quoted reply in the terminal

## Security

The server generates a random authentication token at startup. The token is included in the URL printed to the terminal and stored as an HTTP-only cookie after the first visit. Only users with the token can access the UI.

By default, the server listens on `localhost` only. To expose it on a network interface, change `-listen-addr` accordingly and be aware of the security implications.
