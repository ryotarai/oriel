# Conversation Pane Tabs: Conversation + Diff

## Overview

Add a tab bar to the conversation pane (the top section of each SessionPanel). Two tabs: **Conversation** (existing chat view) and **Diff** (git diff since session start). The Diff tab shows a file tree on the left and per-file unified diff sections on the right.

## Backend Changes

### 1. Capture start commit on session creation

In `internal/ws/handler.go`, when `startProcess` spawns a new PTY, run `git rev-parse HEAD` in the working directory and store the result on the `session` struct as `startCommit string`.

### 2. New API endpoint: `GET /api/diff?session=<id>`

Returns JSON with per-file diff data computed against `startCommit`.

**Implementation:**
- Run `git diff --name-status <startCommit>` to get the file list with statuses (M/A/D/R).
- Run `git diff <startCommit> -- <file>` for each changed file to get per-file unified diff.
- Run `git ls-files --others --exclude-standard` for untracked new files; include their full content as an "add all" diff.
- Return JSON response:

```json
{
  "files": [
    {
      "path": "frontend/src/App.tsx",
      "status": "M",
      "diff": "@@ -10,7 +10,8 @@\n context\n-old line\n+new line\n context"
    },
    {
      "path": "frontend/src/components/NewFile.tsx",
      "status": "A",
      "diff": "+entire file content"
    }
  ]
}
```

**Edge cases:**
- If `startCommit` is empty (new repo with no commits), treat all tracked files as new.
- If session ID is unknown, return 404.
- Binary files: include in file list with status but `diff: null`.

### 3. Route registration

Add `GET /api/diff` to the mux in `cmd/server/main.go`.

## Frontend Changes

### 1. Tab bar component

At the top of the chat panel area in `SessionPanel.tsx`, add a tab bar with two tabs: "Conversation" and "Diff". Styled as minimal tabs matching the dark theme (`bg-gray-800` area).

- Active tab: highlighted text, bottom border accent
- Inactive tab: muted text, no border
- Tab bar height: compact (~32-36px)

### 2. Conversation tab

Existing chat view, unchanged. Rendered when "Conversation" tab is active.

### 3. Diff tab layout

Split into two panels:

**Left panel (file tree, ~250px wide):**
- Flat list of changed files sorted by path
- Each entry shows: status badge (M=yellow, A=green, D=red) + file path (basename bold, directory path muted)
- Click scrolls the right panel to that file's diff section
- Active/selected file highlighted

**Right panel (diff view, remaining width):**
- Scrollable list of file sections
- Each section:
  - File header: file path + status badge (sticky or visually distinct)
  - Unified diff block with syntax coloring:
    - `+` lines: green background (`bg-green-900/30`, green text)
    - `-` lines: red background (`bg-red-900/30`, red text)
    - Context lines: default text
    - `@@` hunk headers: muted/blue text
  - Monospace font, matching terminal font

### 4. Auto-refresh

- Poll `GET /api/diff?session=<id>` every 3 seconds while connected.
- Update file list and diff content on each response.
- Preserve scroll position and selected file across refreshes when possible.

### 5. New component files

- `frontend/src/components/DiffPanel.tsx` — main Diff tab component (file tree + diff view)
- Diff parsing/rendering logic lives within DiffPanel (no separate parser needed; split by lines and color by prefix)

## Non-goals

- Side-by-side diff view
- Nested directory tree (flat list is sufficient)
- Syntax highlighting within diff (only diff-level coloring: +/- lines)
- Inline commenting or editing
