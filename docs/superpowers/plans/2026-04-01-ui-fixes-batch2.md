# UI Fixes Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 open tasks: show target directory in Diff/Files/Commits tabs, show Edit tool errors, fix conversation scroll hijacking, fix pane width on drag-reorder, fix running session pulse animation.

**Architecture:** All changes are frontend-only (React/TypeScript). Each task is independent and touches different components.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, @dnd-kit

---

### Task 1: Show target directory in Diff/Files/Commits tabs

**Context:** Diff/Files/Commits tabs operate on `effectiveDir` (worktreeDir || cwd) but don't display which directory they target. User wants a subtle indicator next to the "Wrap lines" checkbox, with `~` abbreviation for home directory.

**Files:**
- Modify: `frontend/src/components/DiffPanel.tsx:55-67`
- Modify: `frontend/src/components/FileExplorer.tsx:63-74`
- Modify: `frontend/src/components/CommitsPanel.tsx:41-42`
- Modify: `frontend/src/SessionPanel.tsx:524,528,532` (pass `effectiveDir` to DiffPanel and CommitsPanel)

- [ ] **Step 1: Add `cwd` prop to DiffPanel**

In `frontend/src/components/DiffPanel.tsx`, add `cwd` to the props interface:

```typescript
interface DiffPanelProps {
  files: FileDiffData[];
  onSendInput?: (text: string) => void;
  cwd?: string;
}
```

Update the component signature:

```typescript
export function DiffPanel({ files, onSendInput, cwd }: DiffPanelProps) {
```

Add a helper function at the top of the file (before the component):

```typescript
function abbreviateHome(path: string): string {
  const home = typeof window !== "undefined" ? "" : "";
  // We'll get home from an env-like approach, but simpler: check common prefixes
  if (path.startsWith("/Users/")) {
    const parts = path.split("/");
    return "~" + path.slice(parts.slice(0, 3).join("/").length);
  }
  if (path.startsWith("/home/")) {
    const parts = path.split("/");
    return "~" + path.slice(parts.slice(0, 3).join("/").length);
  }
  return path;
}
```

Add the directory display in the toolbar row (line ~57), after the Wrap lines label:

```tsx
<div className="flex items-center px-3 py-1 border-b border-gray-800">
  <label className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 cursor-pointer select-none">
    <input
      type="checkbox"
      checked={wrapLines}
      onChange={(e) => setWrapLines(e.target.checked)}
      className="accent-blue-500"
    />
    Wrap lines
  </label>
  {cwd && (
    <span className="ml-auto text-[10px] text-gray-600 font-mono truncate max-w-[50%]" title={cwd}>
      {abbreviateHome(cwd)}
    </span>
  )}
</div>
```

- [ ] **Step 2: Add directory display to FileExplorer**

In `frontend/src/components/FileExplorer.tsx`, the `cwd` prop already exists. Add the same `abbreviateHome` helper and add the directory display after the Wrap lines label in the toolbar (line ~65-74):

```tsx
<div className="flex items-center px-3 py-1 border-b border-gray-800">
  <label className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 cursor-pointer select-none">
    <input
      type="checkbox"
      checked={wrapLines}
      onChange={(e) => setWrapLines(e.target.checked)}
      className="accent-blue-500"
    />
    Wrap lines
  </label>
  {cwd && (
    <span className="ml-auto text-[10px] text-gray-600 font-mono truncate max-w-[50%]" title={cwd}>
      {abbreviateHome(cwd)}
    </span>
  )}
</div>
```

- [ ] **Step 3: Add directory display to CommitsPanel**

In `frontend/src/components/CommitsPanel.tsx`, add a toolbar row above the commit list. The component currently has no toolbar, so wrap it:

```tsx
export function CommitsPanel({ cwd }: { cwd?: string }) {
  // ... existing state/effects ...

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {cwd && (
        <div className="flex items-center px-3 py-1 border-b border-gray-800">
          <span className="ml-auto text-[10px] text-gray-600 font-mono truncate max-w-[50%]" title={cwd}>
            {abbreviateHome(cwd)}
          </span>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        {/* existing commit list and detail panes */}
      </div>
    </div>
  );
}
```

Add the same `abbreviateHome` helper to this file.

- [ ] **Step 4: Pass effectiveDir to DiffPanel in SessionPanel**

In `frontend/src/SessionPanel.tsx` line 524, add `cwd` prop:

```tsx
<DiffPanel files={diffFiles} onSendInput={sendInputToTerminal} cwd={effectiveDir || undefined} />
```

- [ ] **Step 5: Extract abbreviateHome to a shared utility**

Since all three components use the same helper, create `frontend/src/utils/paths.ts`:

```typescript
export function abbreviateHome(path: string): string {
  if (path.startsWith("/Users/")) {
    const parts = path.split("/");
    return "~" + path.slice(parts.slice(0, 3).join("/").length);
  }
  if (path.startsWith("/home/")) {
    const parts = path.split("/");
    return "~" + path.slice(parts.slice(0, 3).join("/").length);
  }
  return path;
}
```

Update all three components to import from this utility instead of defining inline.

- [ ] **Step 6: Verify and commit**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && cd frontend && npx tsc --noEmit`
Expected: No type errors

```bash
git add frontend/src/utils/paths.ts frontend/src/components/DiffPanel.tsx frontend/src/components/FileExplorer.tsx frontend/src/components/CommitsPanel.tsx frontend/src/SessionPanel.tsx
git commit -m "Show target directory in Diff/Files/Commits tabs"
```

---

### Task 2: Show Edit tool errors visibly in conversation

**Context:** When Edit tool fails (e.g. `is_error: true` with `<tool_use_error>...</tool_use_error>` content), the tool result is currently hidden because Edit tool results are filtered out in the entry filter (SessionPanel.tsx lines 505-512). Failed Edit results should be shown with error styling.

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:505-512` (filter logic)

- [ ] **Step 1: Update the filter to show error results for Edit/Write tools**

In `frontend/src/SessionPanel.tsx`, the filter at lines 506-512 currently hides ALL tool results for Edit and Write. Change it to only hide non-error results:

Current code:
```typescript
if (entry.type === "tool_result") {
  const matchingUse = entries.find(
    (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId
  );
  if (matchingUse && (matchingUse.toolName === "Edit" || matchingUse.toolName === "Write" || matchingUse.toolName === "TaskCreate" || matchingUse.toolName === "TaskUpdate")) {
    return false;
  }
}
```

New code:
```typescript
if (entry.type === "tool_result") {
  const matchingUse = entries.find(
    (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId
  );
  if (matchingUse && (matchingUse.toolName === "TaskCreate" || matchingUse.toolName === "TaskUpdate")) {
    return false;
  }
  // Hide successful Edit/Write results but show errors
  if (matchingUse && (matchingUse.toolName === "Edit" || matchingUse.toolName === "Write") && !entry.isError) {
    return false;
  }
}
```

- [ ] **Step 2: Verify and commit**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend && npx tsc --noEmit`
Expected: No type errors

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Show Edit/Write tool errors in conversation tab"
```

---

### Task 3: Fix conversation scroll hijacking

**Context:** When user scrolls up to read history, new messages force scroll back to bottom. The current logic (SessionPanel.tsx lines 268-286) tracks `isNearBottom` via scroll events and auto-scrolls on `entries` change. The bug is that `isNearBottom.current` is initialized to `true` (default for useRef) and the scroll handler only updates it on scroll events. When new entries arrive and the DOM grows, the scroll position relative to the bottom changes, but `isNearBottom` doesn't get re-evaluated — it still holds the last scroll-event value. The real issue is likely that `scrollIntoView({ behavior: "smooth" })` triggers scroll events that set `isNearBottom` back to true during the animation.

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:268-286`

- [ ] **Step 1: Fix auto-scroll to not re-trigger during smooth scroll animation**

Replace the scroll tracking logic (lines 268-286) with a version that ignores programmatic scrolls:

```typescript
const programmaticScroll = useRef(false);

// Track whether user is near the bottom of the chat scroll container
useEffect(() => {
  const el = chatScrollRef.current;
  if (!el) return;
  const handleScroll = () => {
    if (programmaticScroll.current) return;
    const threshold = 80;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };
  el.addEventListener("scroll", handleScroll, { passive: true });
  return () => el.removeEventListener("scroll", handleScroll);
}, []);

// Auto-scroll chat only when user is near the bottom
useEffect(() => {
  if (isNearBottom.current) {
    const el = chatScrollRef.current;
    if (el) {
      programmaticScroll.current = true;
      el.scrollTop = el.scrollHeight;
      // Reset after a frame to allow the scroll to complete
      requestAnimationFrame(() => {
        programmaticScroll.current = false;
      });
    }
  }
}, [entries]);
```

Key changes:
1. Added `programmaticScroll` ref to ignore scroll events triggered by our own scrolling
2. Use `el.scrollTop = el.scrollHeight` (instant) instead of `scrollIntoView({ behavior: "smooth" })` to avoid animation triggering scroll events over time
3. Reset the flag after a frame

- [ ] **Step 2: Verify and commit**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend && npx tsc --noEmit`
Expected: No type errors

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Fix conversation scroll hijacking when user scrolls up"
```

---

### Task 4: Fix pane width not preserved on drag-reorder

**Context:** When panes are reordered via drag-and-drop, widths get swapped with positions instead of following the panes. The issue is in `App.tsx` line 78-87: `handleDragEnd` reorders `panes` array but doesn't reorder `splits`. Splits are position-based percentages (divider positions between panes), not per-pane widths. When panes swap, the splits stay in place, so pane A gets pane B's width.

The fix: when panes are reordered, also reorder the widths to follow each pane.

**Files:**
- Modify: `frontend/src/App.tsx:78-87`

- [ ] **Step 1: Fix handleDragEnd to preserve pane widths**

Replace the `handleDragEnd` function (lines 78-87):

```typescript
const handleDragEnd = useCallback((event: DragEndEvent) => {
  const { active, over } = event;
  if (!over || active.id === over.id) return;

  setPanes((prev) => {
    const oldIndex = prev.findIndex((p) => p.id === active.id);
    const newIndex = prev.findIndex((p) => p.id === over.id);
    const newPanes = arrayMove(prev, oldIndex, newIndex);

    // Reorder widths to follow the panes
    setSplits((prevSplits) => {
      const oldWidths = computeWidths(prev.length, prevSplits);
      const newWidths = arrayMove(oldWidths, oldIndex, newIndex);
      // Convert widths back to split positions (cumulative sums)
      const newSplits: number[] = [];
      let cumulative = 0;
      for (let i = 0; i < newWidths.length - 1; i++) {
        cumulative += newWidths[i];
        newSplits.push(cumulative);
      }
      return newSplits;
    });

    return newPanes;
  });
}, []);
```

- [ ] **Step 2: Verify and commit**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend && npx tsc --noEmit`
Expected: No type errors

```bash
git add frontend/src/App.tsx
git commit -m "Fix pane width preservation on drag-reorder"
```

---

### Task 5: Fix running session pane pulse animation

**Context:** The `running` state (SessionPanel.tsx:87) is toggled by terminal output: set to `true` on any output, then a 1500ms timer sets it to `false`. This means it pulses briefly on ANY terminal output (including echoed keystrokes when user types), and stops pulsing during actual long-running tool execution if there's a >1.5s gap between output chunks.

The real fix: detect running state from conversation entries rather than terminal output. When Claude is "running" (processing), the JSONL will show assistant messages being generated. A better heuristic: set running=true when the last entry is an assistant message or tool_use (Claude is working), and running=false when the last entry is a tool_result with user input prompt, or when there's been no new entry for a while after the user sent a message.

Actually, a simpler approach: track based on conversation state. Claude is "running" when:
- The last conversation entry is from the assistant (text or tool_use), meaning Claude is actively producing output
- NOT running when the last entry is from the user or is empty (waiting for input)

But the conversation entries from JSONL may lag. A better approach: use the existing terminal output detection but with a longer debounce (e.g., 5s) and exclude user-typed input. The terminal output handler receives ALL output including the user's keystrokes echoed back. We can distinguish: `ws.onmessage` with `type: "output"` comes from the pty, which includes both Claude's output AND echoed user keystrokes.

Actually, looking more carefully: the issue is that pressing Enter sends input which triggers output (the echo), which triggers `setRunning(true)`. Then Claude starts processing but may not produce output for a while, so the timer fires and sets running=false.

The best fix: track running state from conversation entries. When a new assistant entry arrives, set running=true. When we detect user input (the user types in the terminal), set running=false. The conversation watcher already distinguishes assistant vs user messages.

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:87-88,196-203,282-286,408`

- [ ] **Step 1: Replace output-based running detection with conversation-based**

Remove the output-based running state (lines 198-203 terminal output handler, keep only `term.write`):

```typescript
if (msg.type === "output") {
  const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
  term.write(bytes);
}
```

Remove the `runningTimer` ref (line 88).

Add running state detection based on conversation entries. After the entries state update logic, add a new useEffect:

```typescript
// Detect running state from conversation entries
useEffect(() => {
  if (entries.length === 0) {
    setRunning(false);
    return;
  }
  const last = entries[entries.length - 1];
  // Claude is running when the last entry is from the assistant (actively producing output)
  // or a tool_use (tool is executing)
  if (last.type === "tool_use" || (last.role === "assistant" && last.type !== "tool_result")) {
    setRunning(true);
  } else {
    setRunning(false);
  }
}, [entries]);
```

- [ ] **Step 2: Verify and commit**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend && npx tsc --noEmit`
Expected: No type errors

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Fix running session pulse to use conversation state instead of terminal output"
```
