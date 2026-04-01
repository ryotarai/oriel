# UI Fixes Batch 2 — Design Spec

## Task 1: Settings Button to Bottom-Right Overlay

**Problem**: The Settings button at `absolute top-1 left-1` shifts pane tabs rightward.

**Solution**: Move to `fixed bottom-2 right-2 z-20`. The gear icon (⚙) and styling remain unchanged, only the position changes. Remove any left-padding/offset on tabs that was compensating for the button.

**Files**: `frontend/src/App.tsx`

## Task 2: Cmd+Left / Cmd+Right Pane Focus Navigation

**Problem**: No keyboard shortcut to move focus between panes.

**Solution**: Add a global `keydown` listener in `App.tsx`:
- `Cmd+ArrowLeft` (mac) / `Ctrl+ArrowLeft` (other): focus the pane to the left
- `Cmd+ArrowRight` (mac) / `Ctrl+ArrowRight` (other): focus the pane to the right
- At edges: do nothing (no wrapping)

**Active pane tracking**: Store `activePaneIndex` in state. Update it when a pane's container receives `focusin` events (event bubbling from terminal/conversation). The global keydown handler reads `activePaneIndex`, computes the target index, and calls `focus()` on the target SessionPanel's imperative handle (already exposed via `forwardRef`).

**SessionPanel handle**: The existing `SessionPanelHandle` interface needs a `focus()` method that calls `termRef.current?.focus()`.

**Files**: `frontend/src/App.tsx`, `frontend/src/SessionPanel.tsx`

## Task 3: Server-to-Client CWD Notification

**Problem**: The initial pane's `cwd` is empty string on the frontend, so Diff/Files/Commits tabs don't display the target directory. The server resolves `os.Getwd()` as fallback but never sends it to the client.

**Solution**: After session creation/join in the WebSocket handler, send a message `{"type": "cwd", "data": "/resolved/path"}` to the client. The frontend `SessionPanel.tsx` handles this message type by calling `onCwdChange(data)`, which propagates up to `App.tsx` and updates the pane's `cwd` state.

**Files**: `internal/ws/handler.go`, `frontend/src/SessionPanel.tsx`
