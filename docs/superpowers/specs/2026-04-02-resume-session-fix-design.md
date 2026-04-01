# Resume Session Fix — Design Spec

## Problem

When Oriel restarts (server restart + browser reload), `claude --resume <uuid>` fails with "No conversation found" in two scenarios:

1. **New tab, no messages sent** — Claude starts, `watchConversation` discovers the session UUID, frontend saves it to DB. On restart, `--resume <uuid>` fails because the session has no conversation data.
2. **New tab, then Resume Session** — User explicitly resumes UUID-A. The frontend may still have the auto-discovered UUID-X (empty session) saved in DB. On restart, `--resume UUID-X` fails.

A third scenario works correctly: **new tab, send a message, restart** — because the session has conversation content.

## Root Cause

`claudeSessionId` conflates two concerns:

- **Auto-discovered UUID**: set by `watchConversation` as soon as the PID file is read, even for empty sessions with no conversation data.
- **User's explicit resume intent**: set when the user clicks "Resume Session" in the modal.

Both write to the same field. The auto-discovered UUID for an empty session overwrites or preempts the user's intent.

## Design

### Principle

`claudeSessionId` means "the session to `--resume` on next restart." It should only be set when the session is actually resumable.

### Backend Changes

**`watchConversation` — delay UUID broadcast until session has content:**

Currently `onSessionID` fires immediately and broadcasts `claude_session_id` to the frontend. Change: store the UUID internally (`s.claudeSessionID`) but defer the broadcast until the first conversation entry arrives via the JSONL watcher. This ensures empty sessions never get a `claudeSessionId` saved to DB.

```
onSessionID fires → store s.claudeSessionID (no broadcast)
first conversation entry arrives → broadcast claude_session_id
```

**`getOrCreateSession` — validate before `--resume` (defense in depth):**

When `resumeID` is provided, check that the JSONL file (`~/.claude/projects/<cwd>/<resumeID>.jsonl`) exists and is non-empty. If not, skip `--resume` and start a fresh session. This prevents errors even if the DB has a stale UUID.

**`-state-db` flag:**

Add a `-state-db` command-line flag to `cmd/oriel/main.go` so tests can use an isolated SQLite database. Default remains `~/.config/oriel/state.sqlite3`.

### Frontend Changes

**`sendResume` — save intent immediately:**

When the user explicitly resumes a session via the Resume modal, immediately update `pane.claudeSessionId` to the target session ID (before sending the WebSocket message). This ensures the DB captures the user's intent regardless of whether `watchConversation` later discovers a UUID.

### Subscriber Replay (already implemented)

On new WebSocket subscriber connect, replay `s.claudeSessionID` if set. This handles the race where the broadcast happened before the subscriber joined.

## Behavior Matrix

| Scenario | claudeSessionId in DB | On Restart |
|---|---|---|
| New tab, no messages | `""` (never broadcast) | Fresh start |
| New tab, send message | UUID-X (broadcast after first entry) | `--resume UUID-X` |
| New tab, resume UUID-A | UUID-A (set by sendResume) | `--resume UUID-A` |
| Resume UUID-A, send more messages | UUID-A or UUID-NEW (last broadcast wins) | `--resume <uuid>` |

## E2E Tests (Playwright)

### Infrastructure

- Playwright test suite in `tests/e2e/`
- Helper to start/stop Oriel server with `-state-db` pointing to a temp file
- Real `claude` command (no mock)
- Read xterm buffer content via `page.evaluate()` to check for error strings

### Test Cases

1. **New tab → restart → reload → fresh start** (no "No conversation found")
2. **New tab → resume session → restart → reload → resumes correctly**
3. **New tab → send message → restart → reload → resumes correctly**

Each test:
1. Starts Oriel with a fresh state DB
2. Opens the browser
3. Performs the scenario actions
4. Stops the server
5. Restarts the server with the same state DB
6. Reloads the browser
7. Waits for terminal output
8. Asserts no "No conversation found" error appears
