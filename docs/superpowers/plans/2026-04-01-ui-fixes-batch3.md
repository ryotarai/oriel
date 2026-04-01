# UI Fixes Batch 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Settings button to bottom-right overlay, add Cmd/Ctrl+Arrow pane focus navigation, and fix missing cwd display in Diff/Files/Commits tabs.

**Architecture:** Three independent changes in App.tsx (settings button position, keyboard shortcut listener), SessionPanel.tsx (focus handle, cwd message handling), and handler.go (send cwd on connect).

**Tech Stack:** React, TypeScript, Go

---

### Task 1: Move Settings button to bottom-right overlay

**Files:**
- Modify: `frontend/src/App.tsx:112-119`

- [ ] **Step 1: Move Settings button from top-left to fixed bottom-right**

In `frontend/src/App.tsx`, replace the Settings button block:

```tsx
          {/* Settings button */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="absolute top-1 left-1 z-20 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs px-2 py-0.5 rounded border border-gray-600"
            title="Settings"
          >
            ⚙
          </button>
```

with:

```tsx
          {/* Settings button */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="fixed bottom-2 right-2 z-20 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs px-2 py-0.5 rounded border border-gray-600"
            title="Settings"
          >
            ⚙
          </button>
```

- [ ] **Step 2: Verify visually**

Run: `cd frontend && npm run dev`

Confirm:
- Settings gear icon appears at bottom-right of the window
- Tabs in panes are no longer shifted right
- Settings modal still opens correctly when clicked
- Button stays fixed when scrolling/resizing

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "Move Settings button to bottom-right overlay"
```

---

### Task 2: Add Cmd/Ctrl+Arrow pane focus navigation

**Files:**
- Modify: `frontend/src/App.tsx` (add state, refs, effect for keydown listener)
- Modify: `frontend/src/SessionPanel.tsx:38-41,162-165` (add `focus` to imperative handle)

- [ ] **Step 1: Add `focus` method to SessionPanelHandle**

In `frontend/src/SessionPanel.tsx`, add `focus` to the `SessionPanelHandle` interface:

```tsx
export interface SessionPanelHandle {
  openResumeModal: () => void;
  openCwdPicker: () => void;
  focus: () => void;
}
```

And add it to the `useImperativeHandle` call (around line 162):

```tsx
  useImperativeHandle(ref, () => ({
    openResumeModal,
    openCwdPicker: () => { setShowCwdPicker(true); fetchDirs(cwd ?? ""); },
    focus: () => { termRef.current?.focus(); },
  }), [openResumeModal, fetchDirs, cwd]);
```

- [ ] **Step 2: Store pane refs in App.tsx and track active pane index**

In `frontend/src/App.tsx`, add a ref map and active pane state in the `App` component:

```tsx
  const paneRefs = useRef<Map<string, SessionPanelHandle>>(new Map());
  const [activePaneIndex, setActivePaneIndex] = useState(0);
```

Pass a callback ref setter to `PaneWithDivider`. Add `onRef` and `onFocus` to the props interface:

```tsx
interface PaneWithDividerProps {
  pane: PaneConfig;
  width: number;
  isLast: boolean;
  showClose: boolean;
  onClose: () => void;
  onAdd: () => void;
  onDividerDrag: (posPct: number) => void;
  swapEnterKeys: boolean;
  onCwdChange: (newCwd: string) => void;
  onRef: (handle: SessionPanelHandle | null) => void;
  onFocus: () => void;
}
```

In the `PaneWithDivider` component, wire up the ref and focus detection. Update the function signature:

```tsx
function PaneWithDivider({ pane, width, isLast, showClose, onClose, onAdd, onDividerDrag, swapEnterKeys, onCwdChange, onRef, onFocus }: PaneWithDividerProps) {
  const sessionRef = useRef<SessionPanelHandle>(null);
  const paneContainerRef = useRef<HTMLDivElement>(null);
```

Add a `useEffect` to forward the ref when it changes:

```tsx
  useEffect(() => {
    onRef(sessionRef.current);
    return () => onRef(null);
  });
```

Add a `focusin` listener on the pane container div to detect when focus enters this pane:

```tsx
  useEffect(() => {
    const el = paneContainerRef.current;
    if (!el) return;
    const handler = () => onFocus();
    el.addEventListener("focusin", handler);
    return () => el.removeEventListener("focusin", handler);
  }, [onFocus]);
```

Attach `paneContainerRef` to the pane container div (the one with `ref={setNodeRef}`). Since we need both the sortable ref and our own ref, combine them:

```tsx
      <div
        ref={(node) => { setNodeRef(node); (paneContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = node; }}
        style={style}
        className="h-full min-w-0 relative"
      >
```

- [ ] **Step 3: Pass onRef and onFocus from App to PaneWithDivider**

In the `App` component's pane rendering (around line 131), pass the new props:

```tsx
          {panes.map((pane, i) => (
            <PaneWithDivider
              key={pane.id}
              pane={pane}
              width={paneWidths[i]}
              isLast={i === panes.length - 1}
              showClose={panes.length > 1}
              onClose={() => removePane(pane.id)}
              onAdd={() => addPaneAt(i)}
              onDividerDrag={(posPct) => {
                setSplits((prev) => {
                  const next = [...prev];
                  next[i] = Math.max(10, Math.min(90, posPct));
                  return next;
                });
              }}
              swapEnterKeys={appConfig.swapEnterKeys}
              onCwdChange={(newCwd) => handleCwdChange(pane.id, newCwd)}
              onRef={(handle) => {
                if (handle) paneRefs.current.set(pane.id, handle);
                else paneRefs.current.delete(pane.id);
              }}
              onFocus={() => setActivePaneIndex(i)}
            />
          ))}
```

- [ ] **Step 4: Add global keydown listener for Cmd/Ctrl+Arrow**

In the `App` component, add a `useEffect` for the global keyboard shortcut:

```tsx
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

      e.preventDefault();
      const targetIndex = e.key === "ArrowLeft" ? activePaneIndex - 1 : activePaneIndex + 1;
      if (targetIndex < 0 || targetIndex >= panes.length) return;

      const targetPane = panes[targetIndex];
      const handle = paneRefs.current.get(targetPane.id);
      if (handle) {
        handle.focus();
        setActivePaneIndex(targetIndex);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activePaneIndex, panes]);
```

- [ ] **Step 5: Verify visually**

Run the app with 2+ panes. Confirm:
- `Cmd+Right` moves focus to the right pane (terminal gets focus)
- `Cmd+Left` moves focus to the left pane
- At the leftmost/rightmost pane, the shortcut does nothing
- Clicking in a pane updates which pane is "active" for the shortcut

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/SessionPanel.tsx
git commit -m "Add Cmd/Ctrl+Arrow keyboard shortcut for pane focus navigation"
```

---

### Task 3: Send cwd from server to client on WebSocket connect

**Files:**
- Modify: `internal/ws/handler.go:414-440` (send cwd message after subscription)
- Modify: `frontend/src/SessionPanel.tsx:196-212` (handle cwd message type)

- [ ] **Step 1: Send cwd message from server after client connects**

In `internal/ws/handler.go`, after replaying conversation history (after the `for _, entry := range history` loop, around line 437) and before the exited check, add:

```go
	// Send resolved cwd to client
	s.mu.Lock()
	resolvedCwd := s.cwd
	s.mu.Unlock()
	if resolvedCwd != "" {
		sub.writeJSON(message{Type: "cwd", Data: resolvedCwd})
	}
```

- [ ] **Step 2: Handle cwd message in frontend**

In `frontend/src/SessionPanel.tsx`, in the `ws.onmessage` handler (around line 196-212), add a case for the `cwd` message type after the `worktree_changed` handler:

```tsx
      } else if (msg.type === "cwd" && msg.data) {
        onCwdChange?.(msg.data);
```

Note: `onCwdChange` is captured in the closure when the WebSocket is created. To ensure we always call the latest callback, use a ref. Add near the other refs at the top of the component:

```tsx
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
```

And in the handler use:

```tsx
      } else if (msg.type === "cwd" && msg.data) {
        onCwdChangeRef.current?.(msg.data);
```

- [ ] **Step 3: Verify**

Run the app. Confirm:
- Diff tab shows the target directory (e.g. `~/src/github.com/...`) in the header bar next to "Wrap lines"
- Files tab shows the same directory
- Commits tab shows the same directory
- After changing cwd via the folder picker, the directory updates

- [ ] **Step 4: Commit**

```bash
git add internal/ws/handler.go frontend/src/SessionPanel.tsx
git commit -m "Send cwd from server to client to display in Diff/Files/Commits tabs"
```
