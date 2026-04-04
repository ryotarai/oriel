# Oriel Tasks Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all 10 unchecked tasks from `tmp/tasks.md` — bug fixes, UI improvements, and new features for the Oriel Claude Code wrapper UI.

**Architecture:** Oriel is a Go backend + React 19 frontend (TypeScript, Tailwind CSS, Vite). The backend manages PTY sessions via WebSocket, serves conversation data from Claude Code's JSONL logs, and provides APIs for diffs/files. The frontend renders a multi-pane layout with terminal (xterm), conversation view, diff viewer, and file explorer. Each pane is an independent session with its own PTY.

**Tech Stack:** Go 1.26, React 19, TypeScript, Tailwind CSS 4, xterm.js 6, @dnd-kit, highlight.js, react-markdown

---

### Task 1: Fix xterm font size — make it one size smaller

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:114-122` (Terminal constructor options)

- [ ] **Step 1: Change fontSize from 13 to 12**

In `frontend/src/SessionPanel.tsx`, find the Terminal constructor (around line 114):

```typescript
const term = new Terminal({
  cursorBlink: true,
  fontSize: 12,
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  theme: {
    background: "#0a0a0f",
    foreground: "#e4e4e7",
  },
});
```

Change `fontSize: 13` to `fontSize: 12`.

- [ ] **Step 2: Build and verify**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Reduce xterm font size from 13 to 12"
```

---

### Task 2: Fix pane drag reorder resetting pane widths

**Files:**
- Modify: `frontend/src/App.tsx:65-80` (handleDragEnd callback)

The bug: `handleDragEnd` recalculates splits evenly after reorder, discarding any custom widths the user set by dragging dividers. The fix is to reorder the splits array to match the new pane order instead of redistributing evenly.

- [ ] **Step 1: Fix handleDragEnd to preserve widths**

In `frontend/src/App.tsx`, replace the `handleDragEnd` callback:

```typescript
const handleDragEnd = useCallback((event: DragEndEvent) => {
  const { active, over } = event;
  if (!over || active.id === over.id) return;

  setPanes((prev) => {
    const oldIndex = prev.findIndex((p) => p.id === active.id);
    const newIndex = prev.findIndex((p) => p.id === over.id);
    return arrayMove(prev, oldIndex, newIndex);
  });
  // Splits stay the same — they define divider positions between panes,
  // and the pane content just swaps. The widths are derived from split
  // positions, not from pane identity, so no adjustment needed.
}, []);
```

The key insight: splits define divider positions as percentages of the total width (e.g., [33, 66] for 3 equal panes). When panes are reordered, the divider positions don't change — only which pane sits in which slot changes. So we just `arrayMove` the panes array and leave `splits` untouched.

- [ ] **Step 2: Build and verify**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "Fix pane drag reorder resetting custom widths"
```

---

### Task 3: Show "Add pane" button on all panes

**Files:**
- Modify: `frontend/src/App.tsx:89-106,123-213` (PaneWithDivider rendering)

Currently the `+` button only shows when `isLast`. Need to show it on all panes and insert the new pane to the right of the clicked pane.

- [ ] **Step 1: Add addPaneAfter callback and update rendering**

In `frontend/src/App.tsx`, change `addPane` to accept an optional index parameter for where to insert:

```typescript
const addPaneAt = useCallback((afterIndex: number) => {
  const newId = `pane-${Date.now()}`;
  const newSessionId = `session-${Date.now()}`;
  setPanes((prev) => {
    const next = [...prev];
    next.splice(afterIndex + 1, 0, { id: newId, sessionId: newSessionId });
    // Redistribute splits evenly for the new pane count
    const positions: number[] = [];
    for (let i = 1; i < next.length; i++) {
      positions.push((i / next.length) * 100);
    }
    setSplits(positions);
    return next;
  });
}, []);
```

Update the panes.map to pass the index-specific add callback and always show the button:

```typescript
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
  />
))}
```

In the `PaneWithDivider` component, remove the `{isLast && (...)}` guard around the `+` button so it always renders:

```typescript
<button
  onClick={onAdd}
  className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
  title="Add pane"
>
  +
</button>
```

Remove the old `addPane` function (replaced by `addPaneAt`).

- [ ] **Step 2: Build and verify**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "Show Add pane button on all panes, insert to the right"
```

---

### Task 4: Fix quote-reply R key sending to wrong pane

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:232-254` (quote-reply keydown handler)

The bug: The `keydown` listener is attached to `document`, so pressing R with selected text sends the quote to whichever pane's `wsRef` happens to be in scope — typically the last rendered pane. Fix: check that the selection is within this pane's DOM element before acting.

- [ ] **Step 1: Scope the R key handler to the pane's container**

In `frontend/src/SessionPanel.tsx`, add a ref for the panel root div. The component already has a root `<div className="h-full flex flex-col ...">`. Add a ref:

```typescript
const panelRef = useRef<HTMLDivElement>(null);
```

Attach it to the root div:

```typescript
<div ref={panelRef} className="h-full flex flex-col overflow-hidden relative">
```

Then update the quote-reply effect to check that the selection anchor is within this panel:

```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "r" || e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = window.getSelection();
    const text = sel?.toString();
    if (!text) return;

    // Only act if the selection is within this panel
    const anchor = sel?.anchorNode;
    if (!anchor || !panelRef.current?.contains(anchor as Node)) return;

    const ws = wsRef.current;
    const term = termRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;

    e.preventDefault();
    const quoted = text.split("\n").map((line) => `> ${line}`).join("\n") + "\n";
    const bytes = new TextEncoder().encode(quoted);
    const base64 = btoa(String.fromCharCode(...bytes));
    ws.send(JSON.stringify({ type: "input", data: base64 }));
    sel?.removeAllRanges();
    term.focus();
  };
  document.addEventListener("keydown", handleKeyDown);
  return () => document.removeEventListener("keydown", handleKeyDown);
}, []);
```

- [ ] **Step 2: Build and verify**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Scope quote-reply R key to the pane containing the selection"
```

---

### Task 5: Add "Wrap lines" checkbox to Diff and Files tabs

**Files:**
- Modify: `frontend/src/components/DiffPanel.tsx` (add wrapLines state + checkbox + apply to pre)
- Modify: `frontend/src/components/FileExplorer.tsx` (add wrapLines state + checkbox + apply to pre)

- [ ] **Step 1: Add wrap lines toggle to DiffPanel**

In `frontend/src/components/DiffPanel.tsx`, add state at the top of the `DiffPanel` component and import `useState`:

```typescript
import { useRef, useCallback, useState } from "react";
```

Inside `DiffPanel`:

```typescript
const [wrapLines, setWrapLines] = useState(true);
```

Add a toolbar row above the two-pane layout (between the `if (files.length === 0)` early return and the `return` with the two-pane layout):

```typescript
return (
  <div className="flex flex-col flex-1 min-h-0">
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
    </div>
    <div className="flex flex-1 min-h-0">
      {/* existing file tree + diff sections */}
    </div>
  </div>
);
```

Pass `wrapLines` to `DiffBlock`:

```typescript
<DiffBlock diff={f.diff} filePath={f.path} onSendInput={onSendInput} wrapLines={wrapLines} />
```

Update `DiffBlock` to accept and use `wrapLines`:

```typescript
function DiffBlock({ diff, filePath, onSendInput, wrapLines }: { diff: string; filePath: string; onSendInput?: (text: string) => void; wrapLines: boolean }) {
```

On the `<pre>` element, conditionally add `whitespace-pre-wrap` or `whitespace-pre`:

```typescript
<pre className={`text-xs font-mono leading-5 px-0 py-1 ${wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
```

And on the `<span>` for line content, add `overflow-x-auto` when not wrapping:

```typescript
<span className={`flex-1 pr-4 ${wrapLines ? "" : "overflow-x-auto"}`}>{line || "\u00a0"}</span>
```

- [ ] **Step 2: Add wrap lines toggle to FileExplorer**

In `frontend/src/components/FileExplorer.tsx`, add state:

```typescript
const [wrapLines, setWrapLines] = useState(true);
```

Add a toolbar above the two-pane layout in the FileExplorer return. Wrap the existing two-pane div in a flex column container:

```typescript
return (
  <div className="flex flex-col h-full min-h-0">
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
    </div>
    <div className="flex flex-1 min-h-0">
      {/* existing file tree + viewer */}
    </div>
  </div>
);
```

Pass `wrapLines` to `HighlightedCode`:

```typescript
<HighlightedCode content={fileContent ?? ""} path={selectedPath} onSendInput={onSendInput} wrapLines={wrapLines} />
```

Update `HighlightedCode` signature and apply to the `<pre>`:

```typescript
function HighlightedCode({ content, path, onSendInput, wrapLines }: { content: string; path: string; onSendInput?: (text: string) => void; wrapLines: boolean }) {
```

```typescript
<pre className={`text-xs font-mono py-3 leading-relaxed text-gray-200 ${wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
```

- [ ] **Step 3: Build and verify**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/DiffPanel.tsx frontend/src/components/FileExplorer.tsx
git commit -m "Add Wrap lines checkbox to Diff and Files tabs (default on)"
```

---

### Task 6: Improve Edit/Write tool UI in conversation

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:586-609` (ToolUseBlock component)

Requirements:
- **ToolResultBlock**: Don't show for Edit and Write tools (Result not needed)
- **Write tool**: Show `file_path` in summary, show `content` as a collapsible code block
- **Edit tool**: Show `file_path` in summary, show `old_string`/`new_string` as a collapsible unified diff

- [ ] **Step 1: Hide tool results for Edit and Write**

We need to correlate tool_result entries with their tool_use entries. Add a map to track tool_use IDs to tool names. In `SessionPanel`, before the filter/map of entries, build a lookup:

In the conversation rendering section, filter out tool_result entries whose corresponding tool_use is Edit or Write. Update the filter in the entries rendering:

```typescript
{entries.filter((entry) => {
  if (!showTools && (entry.type === "tool_use" || entry.type === "tool_result")) return false;
  // Hide tool results for Edit and Write tools
  if (entry.type === "tool_result") {
    const matchingUse = entries.find(
      (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId
    );
    if (matchingUse && (matchingUse.toolName === "Edit" || matchingUse.toolName === "Write")) {
      return false;
    }
  }
  return true;
}).map((entry) => (
  <MessageBubble key={entry.uuid} entry={entry} onOpenFile={openFileInExplorer} />
))}
```

- [ ] **Step 2: Improve Write tool display — show content as code block**

In the `ToolUseBlock` component, add special rendering for Write tool. After the summary button, when expanded, show the content field as a syntax-highlighted code block instead of raw JSON:

```typescript
function ToolUseBlock({ entry }: { entry: ConversationEntry }) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolUseSummary(entry.toolName ?? "", entry.toolInput ?? "");

  // Parse input for special rendering
  let parsedInput: Record<string, unknown> | null = null;
  try {
    parsedInput = JSON.parse(entry.toolInput ?? "{}");
  } catch {}

  const isWrite = entry.toolName === "Write";
  const isEdit = entry.toolName === "Edit";

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-1.5 hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">{expanded ? "▼" : "▶"}</span>
          <span className="text-green-400 font-medium">{entry.toolName}</span>
          <span className="text-gray-400 truncate">{summary}</span>
        </div>
      </button>
      {expanded && isWrite && parsedInput?.content != null && (
        <div className="mt-1 rounded-lg bg-gray-900 border border-gray-700/50 overflow-hidden">
          <pre className="px-3 py-2 text-xs font-mono text-gray-300 whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto">
            {String(parsedInput.content)}
          </pre>
        </div>
      )}
      {expanded && isEdit && parsedInput && (
        <div className="mt-1 rounded-lg bg-gray-900 border border-gray-700/50 overflow-hidden">
          <EditDiff
            oldStr={String(parsedInput.old_string ?? "")}
            newStr={String(parsedInput.new_string ?? "")}
          />
        </div>
      )}
      {expanded && !isWrite && !isEdit && entry.toolInput && (
        <div className="mt-1 rounded-lg bg-gray-900 border border-gray-700/50 px-3 py-2 text-xs font-mono text-gray-300 whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto">
          {formatToolInput(entry.toolInput)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add EditDiff component for unified diff display**

Add a new component after `ToolUseBlock`:

```typescript
function EditDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  // Simple unified diff: show removed lines then added lines
  return (
    <pre className="px-3 py-2 text-xs font-mono max-h-60 overflow-y-auto">
      {oldLines.map((line, i) => (
        <div key={`old-${i}`} className="text-red-300 bg-red-900/20">
          <span className="select-none text-red-500 mr-1">-</span>{line || "\u00a0"}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`new-${i}`} className="text-green-300 bg-green-900/20">
          <span className="select-none text-green-500 mr-1">+</span>{line || "\u00a0"}
        </div>
      ))}
    </pre>
  );
}
```

- [ ] **Step 4: Build and verify**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Improve Edit/Write tool UI with code blocks and unified diff"
```

---

### Task 7: Show TaskCreate/TaskUpdate as overlay instead of tool blocks

**Files:**
- Modify: `frontend/src/SessionPanel.tsx` (add task tracking state, overlay component, filter tasks from tool list)

Requirements: Instead of showing TaskCreate/TaskUpdate as regular tool use blocks in conversation, maintain a task list state and display it as an overlay in the top-right corner of the conversation pane.

- [ ] **Step 1: Add task state tracking**

In `SessionPanel`, add state for tracking tasks:

```typescript
interface TaskItem {
  taskId: string;
  subject: string;
  status: string;  // "pending", "in_progress", "completed"
}

// Inside SessionPanel component:
const [tasks, setTasks] = useState<TaskItem[]>([]);
```

- [ ] **Step 2: Extract task info from conversation entries**

Add an effect that processes entries to extract task state. Watch for tool_use entries with TaskCreate and TaskUpdate, and their corresponding tool_result entries to get the taskId:

```typescript
useEffect(() => {
  const taskMap = new Map<string, TaskItem>();

  for (const entry of entries) {
    if (entry.type !== "tool_use") continue;
    try {
      const input = JSON.parse(entry.toolInput ?? "{}");
      if (entry.toolName === "TaskCreate") {
        // TaskCreate result contains the taskId, but we can use toolUseId as temp key
        // We'll match it with the result later. For now, use subject as display.
        taskMap.set(entry.toolUseId ?? entry.uuid, {
          taskId: entry.toolUseId ?? entry.uuid,
          subject: input.subject ?? "Task",
          status: "pending",
        });
      } else if (entry.toolName === "TaskUpdate") {
        // Find existing task and update status
        const taskId = input.taskId;
        if (taskId) {
          for (const [key, task] of taskMap) {
            // Match by taskId suffix (TaskCreate results include "#N" format)
            if (key.endsWith(taskId) || task.taskId === taskId) {
              task.status = input.status ?? task.status;
              break;
            }
          }
        }
      }
    } catch {}
  }

  // Also check tool_result entries for TaskCreate to get real taskId
  for (const entry of entries) {
    if (entry.type !== "tool_result" || !entry.toolUseId) continue;
    const matchingUse = entries.find(
      (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId && e.toolName === "TaskCreate"
    );
    if (matchingUse && entry.text) {
      const idMatch = entry.text.match(/Task #(\d+)/i) || entry.text.match(/#(\d+)/);
      if (idMatch) {
        const existing = taskMap.get(matchingUse.toolUseId ?? matchingUse.uuid);
        if (existing) {
          existing.taskId = idMatch[1];
        }
      }
    }
  }

  setTasks(Array.from(taskMap.values()));
}, [entries]);
```

- [ ] **Step 3: Filter TaskCreate/TaskUpdate from conversation display**

Update the entries filter to hide TaskCreate and TaskUpdate tool_use and their results:

```typescript
if (entry.type === "tool_use" && (entry.toolName === "TaskCreate" || entry.toolName === "TaskUpdate")) {
  return false;
}
if (entry.type === "tool_result") {
  const matchingUse = entries.find(
    (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId
  );
  if (matchingUse && (matchingUse.toolName === "TaskCreate" || matchingUse.toolName === "TaskUpdate" || matchingUse.toolName === "Edit" || matchingUse.toolName === "Write")) {
    return false;
  }
}
```

(Merge this with the Edit/Write filter from Task 6.)

- [ ] **Step 4: Add TaskOverlay component**

```typescript
function TaskOverlay({ tasks }: { tasks: TaskItem[] }) {
  if (tasks.length === 0) return null;

  return (
    <div className="absolute top-10 right-2 z-10 w-64 bg-gray-900/95 border border-gray-700 rounded-lg shadow-lg backdrop-blur-sm overflow-hidden">
      <div className="px-3 py-1.5 border-b border-gray-700 text-xs font-medium text-gray-300">
        Tasks
      </div>
      <div className="max-h-48 overflow-y-auto">
        {tasks.map((task) => (
          <div key={task.taskId} className="px-3 py-1 flex items-center gap-2 text-xs">
            <span className={
              task.status === "completed" ? "text-green-400" :
              task.status === "in_progress" ? "text-yellow-400" :
              "text-gray-500"
            }>
              {task.status === "completed" ? "✓" : task.status === "in_progress" ? "●" : "○"}
            </span>
            <span className={
              task.status === "completed" ? "text-gray-500 line-through" : "text-gray-300"
            }>
              {task.subject}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Render the overlay in conversation tab**

In the conversation tab content area (the `{activeTab === "conversation" ? (` branch), add the overlay inside the flex container, right after the `<div className="flex-1 flex flex-col min-h-0">`:

```typescript
{activeTab === "conversation" ? (
  <div className="flex-1 flex flex-col min-h-0 relative">
    <TaskOverlay tasks={tasks} />
    {/* existing toolbar and scroll area */}
  </div>
```

- [ ] **Step 6: Build and verify**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Show TaskCreate/TaskUpdate as overlay instead of tool blocks"
```

---

### Task 8: Settings page with Enter/Cmd+Enter toggle

**Files:**
- Create: `internal/config/config.go` (config read/write to `~/.config/oriel/config.json`)
- Modify: `cmd/oriel/main.go` (add `/api/config` GET/PUT endpoints)
- Create: `frontend/src/components/SettingsPage.tsx` (settings UI)
- Modify: `frontend/src/App.tsx` (add settings route/button)
- Modify: `frontend/src/SessionPanel.tsx` (read config to toggle Enter behavior)

- [ ] **Step 1: Create config package (backend)**

Create `internal/config/config.go`:

```go
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	SwapEnterKeys bool `json:"swapEnterKeys"`
}

var (
	mu      sync.RWMutex
	current = Config{SwapEnterKeys: true} // default: swap enabled
)

func configPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "oriel", "config.json")
}

func Load() {
	data, err := os.ReadFile(configPath())
	if err != nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	json.Unmarshal(data, &current)
}

func Get() Config {
	mu.RLock()
	defer mu.RUnlock()
	return current
}

func Set(c Config) error {
	mu.Lock()
	current = c
	mu.Unlock()

	path := configPath()
	os.MkdirAll(filepath.Dir(path), 0o755)
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
```

- [ ] **Step 2: Add API endpoints in main.go**

In `cmd/oriel/main.go`, add imports and routes:

```go
import "github.com/ryotarai/oriel/internal/config"
```

In `main()`, before `http.ListenAndServe`:

```go
config.Load()
mux.HandleFunc("/api/config", handleConfig)
```

Add the handler function:

```go
func handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(config.Get())
	case http.MethodPut:
		var c config.Config
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := config.Set(c); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(c)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
```

Add `"encoding/json"` to imports if not already present.

- [ ] **Step 3: Create SettingsPage component**

Create `frontend/src/components/SettingsPage.tsx`:

```typescript
import { useState, useEffect } from "react";

interface Config {
  swapEnterKeys: boolean;
}

export function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig({ swapEnterKeys: true }));
  }, []);

  const updateConfig = async (updates: Partial<Config>) => {
    if (!config) return;
    const next = { ...config, ...updates };
    setSaving(true);
    try {
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      setConfig(next);
    } catch {}
    setSaving(false);
  };

  if (!config) return <div className="text-gray-500 text-sm p-4">Loading...</div>;

  return (
    <div className="p-6 max-w-lg">
      <h2 className="text-gray-100 text-lg font-medium mb-4">Settings</h2>
      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={config.swapEnterKeys}
            onChange={(e) => updateConfig({ swapEnterKeys: e.target.checked })}
            disabled={saving}
            className="accent-blue-500 w-4 h-4"
          />
          <div>
            <div className="text-gray-200 text-sm">Swap Enter / Cmd+Enter</div>
            <div className="text-gray-500 text-xs mt-0.5">
              When enabled, Enter inserts a newline and Cmd+Enter sends the message (at Claude's ❯ prompt)
            </div>
          </div>
        </label>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add Settings tab to App.tsx**

In `frontend/src/App.tsx`, add a settings modal/page toggle. Add a gear icon button in the top-left of the app, and render `SettingsPage` as a modal overlay:

Import at top:

```typescript
import { SettingsPage } from "./components/SettingsPage";
```

Add state:

```typescript
const [showSettings, setShowSettings] = useState(false);
```

Add the settings button and modal in the return JSX, right inside the outer div before the panes:

```typescript
<div className="h-screen w-screen bg-[#0a0a0f] flex overflow-hidden relative">
  {/* Settings button */}
  <button
    onClick={() => setShowSettings(!showSettings)}
    className="absolute top-1 left-1 z-20 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs px-2 py-0.5 rounded border border-gray-600"
    title="Settings"
  >
    ⚙
  </button>
  {/* Settings overlay */}
  {showSettings && (
    <div className="absolute inset-0 z-30 bg-black/70 flex items-start justify-center pt-16">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-gray-100 font-medium">Settings</h2>
          <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-200 text-lg">×</button>
        </div>
        <SettingsPage />
      </div>
    </div>
  )}
  {/* panes */}
```

- [ ] **Step 5: Pass config to SessionPanel for Enter key behavior**

In `frontend/src/App.tsx`, fetch config and pass it down:

```typescript
const [appConfig, setAppConfig] = useState<{ swapEnterKeys: boolean }>({ swapEnterKeys: true });

useEffect(() => {
  fetch("/api/config").then((r) => r.json()).then(setAppConfig).catch(() => {});
}, [showSettings]); // Re-fetch when settings close
```

Pass to SessionPanel:

```typescript
<SessionPanel
  ref={sessionRef}
  sessionId={pane.sessionId}
  dragHandleProps={{ ...attributes, ...listeners }}
  swapEnterKeys={appConfig.swapEnterKeys}
/>
```

In `SessionPanel`, add the prop:

```typescript
interface SessionPanelProps {
  sessionId: string;
  dragHandleProps?: Record<string, unknown>;
  swapEnterKeys?: boolean;
}
```

Update the `forwardRef` signature and the Enter key handler to check the flag. Use a ref to avoid re-creating the terminal effect:

```typescript
const swapEnterRef = useRef(swapEnterKeys ?? true);
useEffect(() => { swapEnterRef.current = swapEnterKeys ?? true; }, [swapEnterKeys]);
```

In the `attachCustomKeyEventHandler`:

```typescript
if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
  if (!swapEnterRef.current) return true; // Swap disabled — normal Enter
  // ... existing prompt detection and Ctrl+J logic
}
```

- [ ] **Step 6: Build and verify**

Run: `cd frontend && npm run build && cd .. && go build ./cmd/oriel`
Expected: Both build successfully.

- [ ] **Step 7: Commit**

```bash
git add internal/config/config.go cmd/oriel/main.go frontend/src/components/SettingsPage.tsx frontend/src/App.tsx frontend/src/SessionPanel.tsx
git commit -m "Add Settings page with Enter/Cmd+Enter swap toggle"
```

---

### Task 9: Add Commits tab

**Files:**
- Create: `internal/commits/commits.go` (backend: git log + show)
- Modify: `cmd/oriel/main.go` (add `/api/commits` and `/api/commits/show` endpoints)
- Create: `frontend/src/components/CommitsPanel.tsx` (commit list + detail view)
- Modify: `frontend/src/SessionPanel.tsx` (add Commits tab)

- [ ] **Step 1: Create commits backend package**

Create `internal/commits/commits.go`:

```go
package commits

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
)

type CommitSummary struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

type CommitDetail struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
	Body    string `json:"body"`
	Diff    string `json:"diff"`
}

func HandleList(w http.ResponseWriter, r *http.Request) {
	// Get last 100 commits
	out, err := exec.Command("git", "log", "--pretty=format:%H\t%s\t%an\t%ci", "-100").Output()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var commits []CommitSummary
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			continue
		}
		commits = append(commits, CommitSummary{
			Hash:    parts[0],
			Subject: parts[1],
			Author:  parts[2],
			Date:    parts[3],
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(commits)
}

func HandleShow(w http.ResponseWriter, r *http.Request) {
	hash := r.URL.Query().Get("hash")
	if hash == "" {
		http.Error(w, "missing hash", http.StatusBadRequest)
		return
	}

	// Validate hash (prevent injection)
	for _, c := range hash {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			http.Error(w, "invalid hash", http.StatusBadRequest)
			return
		}
	}

	// Get commit message
	msgOut, err := exec.Command("git", "log", "-1", "--pretty=format:%s\n\n%b\n---\nAuthor: %an\nDate: %ci", hash).Output()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Get diff
	diffOut, err := exec.Command("git", "diff-tree", "-p", "--no-commit-id", hash).Output()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	parts := strings.SplitN(string(msgOut), "\n\n", 2)
	subject := parts[0]
	body := ""
	if len(parts) > 1 {
		body = parts[1]
	}

	detail := CommitDetail{
		Hash:    hash,
		Subject: subject,
		Body:    body,
		Diff:    string(diffOut),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(detail)
}
```

- [ ] **Step 2: Register routes in main.go**

In `cmd/oriel/main.go`, add import and routes:

```go
import "github.com/ryotarai/oriel/internal/commits"
```

```go
mux.HandleFunc("/api/commits", commits.HandleList)
mux.HandleFunc("/api/commits/show", commits.HandleShow)
```

- [ ] **Step 3: Create CommitsPanel component**

Create `frontend/src/components/CommitsPanel.tsx`:

```typescript
import { useState, useEffect, useCallback } from "react";

interface CommitSummary {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

interface CommitDetail {
  hash: string;
  subject: string;
  body: string;
  diff: string;
}

export function CommitsPanel() {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/commits")
      .then((r) => r.json())
      .then((data) => setCommits(data ?? []))
      .catch(() => {});
  }, []);

  const selectCommit = useCallback((hash: string) => {
    setSelected(hash);
    setLoading(true);
    fetch(`/api/commits/show?hash=${encodeURIComponent(hash)}`)
      .then((r) => r.json())
      .then((data) => { setDetail(data); setLoading(false); })
      .catch(() => { setDetail(null); setLoading(false); });
  }, []);

  return (
    <div className="flex flex-1 min-h-0">
      {/* Commit list (left) */}
      <div className="w-72 flex-shrink-0 border-r border-gray-800 overflow-y-auto">
        {commits.map((c) => (
          <button
            key={c.hash}
            onClick={() => selectCommit(c.hash)}
            className={`w-full text-left px-3 py-2 border-b border-gray-800/50 transition-colors ${
              selected === c.hash ? "bg-blue-900/30" : "hover:bg-gray-800/60"
            }`}
          >
            <div className="text-gray-200 text-xs truncate">{c.subject}</div>
            <div className="text-gray-500 text-[10px] mt-0.5">
              <span className="text-gray-600 font-mono">{c.hash.slice(0, 7)}</span>
              {" · "}{c.author}{" · "}{formatDate(c.date)}
            </div>
          </button>
        ))}
        {commits.length === 0 && (
          <div className="text-gray-500 text-xs p-3 text-center">No commits</div>
        )}
      </div>

      {/* Commit detail (right) */}
      <div className="flex-1 overflow-y-auto">
        {selected && loading && (
          <div className="text-gray-500 text-sm p-4">Loading...</div>
        )}
        {selected && !loading && detail && (
          <div>
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="text-gray-100 text-sm font-medium">{detail.subject}</div>
              <div className="text-gray-500 text-xs mt-1 font-mono">{detail.hash.slice(0, 12)}</div>
              {detail.body && (
                <pre className="text-gray-400 text-xs mt-2 whitespace-pre-wrap">{detail.body}</pre>
              )}
            </div>
            {detail.diff && <CommitDiff diff={detail.diff} />}
          </div>
        )}
        {!selected && (
          <div className="text-gray-500 text-sm p-4 flex items-center justify-center h-full">
            Select a commit to view
          </div>
        )}
      </div>
    </div>
  );
}

function CommitDiff({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="text-xs font-mono leading-5 px-0 py-1">
      {lines.map((line, i) => {
        let className = "text-gray-400";
        if (line.startsWith("+++ ") || line.startsWith("--- ")) {
          className = "text-gray-500";
        } else if (line.startsWith("@@")) {
          className = "text-blue-400 bg-blue-900/20";
        } else if (line.startsWith("+")) {
          className = "text-green-300 bg-green-900/20";
        } else if (line.startsWith("-")) {
          className = "text-red-300 bg-red-900/20";
        } else if (line.startsWith("diff --git")) {
          return (
            <div key={i} className="text-gray-200 bg-gray-800/60 px-4 py-1 mt-2 first:mt-0 font-medium sticky top-0 z-10">
              {line.replace(/^diff --git a\/(.+) b\/.*/, "$1")}
            </div>
          );
        } else if (line.startsWith("index ")) {
          return null;
        }

        return (
          <div key={i} className={`px-4 ${className}`}>
            {line || "\u00a0"}
          </div>
        );
      })}
    </pre>
  );
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours < 1) return "just now";
    if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
    const diffDays = diffHours / 24;
    if (diffDays < 30) return `${Math.floor(diffDays)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return dateStr;
  }
}
```

- [ ] **Step 4: Add Commits tab to SessionPanel**

In `frontend/src/SessionPanel.tsx`, import and add the tab:

```typescript
import { CommitsPanel } from "./components/CommitsPanel";
```

Update `activeTab` type:

```typescript
const [activeTab, setActiveTab] = useState<"conversation" | "diff" | "files" | "commits">("conversation");
```

Add tab button after the Files tab button:

```typescript
<button
  onClick={() => setActiveTab("commits")}
  className={`px-4 py-2 text-xs font-medium transition-colors ${
    activeTab === "commits"
      ? "text-gray-100 border-b-2 border-blue-500"
      : "text-gray-500 hover:text-gray-300"
  }`}
>
  Commits
</button>
```

Add the tab content after the Files tab content:

```typescript
) : activeTab === "commits" ? (
  <div className="flex-1 flex flex-col min-h-0">
    <CommitsPanel />
  </div>
```

- [ ] **Step 5: Build and verify**

Run: `cd frontend && npm run build && cd .. && go build ./cmd/oriel`
Expected: Both build successfully.

- [ ] **Step 6: Commit**

```bash
git add internal/commits/commits.go cmd/oriel/main.go frontend/src/components/CommitsPanel.tsx frontend/src/SessionPanel.tsx
git commit -m "Add Commits tab with commit list and diff viewer"
```

---

### Task 10: Configurable CWD per pane

**Files:**
- Modify: `internal/ws/handler.go` (accept cwd in session creation, pass to PTY + diff + file APIs)
- Modify: `internal/pty/session.go` (accept cwd parameter)
- Modify: `internal/fileexplorer/fileexplorer.go` (accept cwd from query param)
- Modify: `internal/diff/diff.go` (already accepts cwd parameter)
- Modify: `cmd/oriel/main.go` (pass initial cwd, route file/tree APIs through handler for session-scoped cwd)
- Modify: `frontend/src/App.tsx` (track cwd per pane, pass to SessionPanel)
- Modify: `frontend/src/SessionPanel.tsx` (add cwd button, directory selection, restart with new cwd)

This is the most complex task. The key changes:

1. **Backend**: PTY sessions need a `cwd` field that's used when spawning the process. The handler needs a new WebSocket message type `setCwd` and an API to change it.
2. **Frontend**: Each pane tracks its cwd. New panes inherit the cwd of the pane whose `+` button was clicked. A folder icon button opens a directory picker (text input since native dir picker isn't available in browsers without special APIs).

- [ ] **Step 1: Add cwd support to PTY session**

In `internal/pty/session.go`, update `NewSession` to accept a cwd parameter:

```go
func NewSession(command string, cols, rows uint16, cwd string, args ...string) (*Session, error) {
	cmd := exec.Command(command, args...)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("COLUMNS=%d", cols),
		fmt.Sprintf("LINES=%d", rows),
		"TERM=xterm-256color",
	)
	if cwd != "" {
		cmd.Dir = cwd
	}
	// ... rest unchanged
```

- [ ] **Step 2: Update handler to pass cwd to PTY**

In `internal/ws/handler.go`, update `startProcess` to use `s.cwd`:

```go
func (h *Handler) startProcess(s *session, args ...string) error {
	s.mu.Lock()
	cwd := s.cwd
	s.mu.Unlock()

	ptySess, err := ptylib.NewSession(h.command, s.cols, s.rows, cwd, args...)
	if err != nil {
		return err
	}

	s.mu.Lock()
	s.pty = ptySess
	s.exited = false
	s.mu.Unlock()

	go h.readPtyLoop(s)
	go h.watchConversation(s)

	return nil
}
```

Update `getOrCreateSession` to accept and set initial cwd:

```go
func (h *Handler) getOrCreateSession(id string, cwd string) (*session, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if s, ok := h.sessions[id]; ok {
		return s, nil
	}

	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	s := &session{
		id:        id,
		subs:      make(map[*subscriber]struct{}),
		cols:      120,
		rows:      40,
		cwd:       cwd,
		restartCh: make(chan restartRequest, 1),
	}
	h.sessions[id] = s

	if err := h.startProcess(s); err != nil {
		delete(h.sessions, id)
		return nil, err
	}

	go h.restartLoop(s)
	return s, nil
}
```

Also remove the `cwd, _ := os.Getwd()` from inside `startProcess` since cwd is now set at session creation.

Add a new WebSocket message type for changing cwd:

```go
case "set_cwd":
  newCwd := msg.Data
  if newCwd != "" {
    // Verify directory exists
    if info, err := os.Stat(newCwd); err == nil && info.IsDir() {
      s.mu.Lock()
      s.cwd = newCwd
      s.mu.Unlock()
      // Restart process with new cwd
      select {
      case s.restartCh <- restartRequest{}:
      default:
      }
    }
  }
```

Update `ServeHTTP` to read cwd from query param:

```go
cwd := r.URL.Query().Get("cwd")
s, err := h.getOrCreateSession(sessionID, cwd)
```

- [ ] **Step 3: Update fileexplorer to accept cwd from query param**

In `internal/fileexplorer/fileexplorer.go`, update `HandleTree` and `HandleFile` to read an optional `cwd` query parameter instead of always using `os.Getwd()`:

```go
func HandleTree(w http.ResponseWriter, r *http.Request) {
	root := r.URL.Query().Get("cwd")
	if root == "" {
		var err error
		root, err = os.Getwd()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	tree := buildTree(root, root, 4)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tree)
}
```

Similarly update `HandleFile` to use `cwd` query param as root.

- [ ] **Step 4: Track cwd per pane in App.tsx**

In `frontend/src/App.tsx`, extend `PaneConfig`:

```typescript
interface PaneConfig {
  id: string;
  sessionId: string;
  cwd: string; // empty = inherit process cwd
}
```

Update initial pane:

```typescript
const [panes, setPanes] = useState<PaneConfig[]>([
  { id: "pane-1", sessionId: "session-1", cwd: "" },
]);
```

Update `addPaneAt` to inherit cwd from the source pane:

```typescript
const addPaneAt = useCallback((afterIndex: number) => {
  setPanes((prev) => {
    const sourceCwd = prev[afterIndex]?.cwd ?? "";
    const newId = `pane-${Date.now()}`;
    const newSessionId = `session-${Date.now()}`;
    const next = [...prev];
    next.splice(afterIndex + 1, 0, { id: newId, sessionId: newSessionId, cwd: sourceCwd });
    // ... redistribute splits
    return next;
  });
}, []);
```

Pass cwd to SessionPanel and add a callback for cwd changes:

```typescript
const handleCwdChange = useCallback((paneId: string, newCwd: string) => {
  setPanes((prev) => prev.map((p) => p.id === paneId ? { ...p, cwd: newCwd } : p));
}, []);
```

```typescript
<SessionPanel
  ref={sessionRef}
  sessionId={pane.sessionId}
  cwd={pane.cwd}
  onCwdChange={(newCwd) => handleCwdChange(pane.id, newCwd)}
  dragHandleProps={{ ...attributes, ...listeners }}
  swapEnterKeys={appConfig.swapEnterKeys}
/>
```

- [ ] **Step 5: Add folder button and cwd picker to SessionPanel**

In `frontend/src/SessionPanel.tsx`, add props:

```typescript
interface SessionPanelProps {
  sessionId: string;
  cwd?: string;
  onCwdChange?: (newCwd: string) => void;
  dragHandleProps?: Record<string, unknown>;
  swapEnterKeys?: boolean;
}
```

Add state for the cwd picker:

```typescript
const [showCwdPicker, setShowCwdPicker] = useState(false);
const [cwdInput, setCwdInput] = useState(cwd ?? "");
```

Update the WebSocket URL to include cwd:

```typescript
const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
const wsUrl = `ws://${window.location.host}/ws?session=${encodeURIComponent(sessionId)}${cwdParam}`;
```

Add cwd to the file explorer and diff API calls:

```typescript
// In diff polling:
fetch(`/api/diff?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd ?? "")}`)
```

```typescript
// Pass cwd to FileExplorer
<FileExplorer requestedPath={fileToOpen} onSendInput={sendInputToTerminal} cwd={cwd} />
```

Add the folder icon button in the pane toolbar area (rendered in PaneWithDivider in App.tsx, before the resume button):

```typescript
<button
  onClick={() => setShowCwdPicker(true)}
  className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
  title="Change working directory"
>
  📂
</button>
```

Add a CWD picker modal:

```typescript
{showCwdPicker && (
  <div className="absolute inset-0 bg-black/70 z-20 flex items-center justify-center p-4">
    <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md p-4">
      <h3 className="text-gray-100 text-sm font-medium mb-3">Change Working Directory</h3>
      <p className="text-yellow-400 text-xs mb-3">This will restart the Claude Code session.</p>
      <input
        type="text"
        value={cwdInput}
        onChange={(e) => setCwdInput(e.target.value)}
        className="w-full bg-gray-800 border border-gray-600 text-gray-200 text-sm px-3 py-1.5 rounded font-mono"
        placeholder="/path/to/directory"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter" && cwdInput.trim()) {
            onCwdChange?.(cwdInput.trim());
            setShowCwdPicker(false);
          }
          if (e.key === "Escape") setShowCwdPicker(false);
        }}
      />
      <div className="flex justify-end gap-2 mt-3">
        <button
          onClick={() => setShowCwdPicker(false)}
          className="text-gray-400 text-xs px-3 py-1 rounded hover:bg-gray-800"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            if (cwdInput.trim()) {
              onCwdChange?.(cwdInput.trim());
              setShowCwdPicker(false);
            }
          }}
          className="bg-blue-600 text-white text-xs px-3 py-1 rounded hover:bg-blue-500"
        >
          Change
        </button>
      </div>
    </div>
  </div>
)}
```

When `cwd` prop changes, the `sessionId` changes too (because App.tsx will generate a new sessionId when cwd changes) — this triggers the `useEffect` that creates a new WebSocket connection with the new cwd.

Actually, a simpler approach: when cwd changes, send a `set_cwd` message over WebSocket and the backend handles the restart. Update `handleCwdChange` in App.tsx to also generate a new sessionId to trigger reconnect. Or, expose a `setCwd` function in SessionPanel that sends the WebSocket message.

Better approach: Add an effect in SessionPanel that sends `set_cwd` when `cwd` prop changes:

```typescript
const prevCwdRef = useRef(cwd);
useEffect(() => {
  if (prevCwdRef.current !== cwd && cwd) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_cwd", data: cwd }));
    }
  }
  prevCwdRef.current = cwd;
}, [cwd]);
```

- [ ] **Step 6: Update FileExplorer to accept cwd prop**

In `frontend/src/components/FileExplorer.tsx`, add `cwd` prop and include it in API calls:

```typescript
export function FileExplorer({ requestedPath, onSendInput, cwd }: { requestedPath?: string | null; onSendInput?: (text: string) => void; cwd?: string }) {
```

Update the tree fetch:

```typescript
fetch(`/api/files/tree${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`)
```

Update the file fetch:

```typescript
fetch(`/api/files/read?path=${encodeURIComponent(path)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`)
```

- [ ] **Step 7: Build and verify**

Run: `cd frontend && npm run build && cd .. && go build ./cmd/oriel`
Expected: Both build successfully.

- [ ] **Step 8: Commit**

```bash
git add internal/pty/session.go internal/ws/handler.go internal/fileexplorer/fileexplorer.go cmd/oriel/main.go frontend/src/App.tsx frontend/src/SessionPanel.tsx frontend/src/components/FileExplorer.tsx
git commit -m "Add configurable working directory per pane"
```

---

## Task Dependency Notes

- Tasks 1-5 are independent and can be parallelized.
- Task 6 (Edit/Write UI) and Task 7 (TaskCreate overlay) both modify the entry filtering logic in SessionPanel — they should be done sequentially and the second task should merge the filters.
- Task 8 (Settings) depends on nothing but modifies App.tsx and SessionPanel.tsx — do it after Tasks 2-4 to avoid merge conflicts.
- Task 9 (Commits) is independent of all others.
- Task 10 (CWD) depends on Task 3 (Add pane button on all panes) since it modifies `addPaneAt` and PaneConfig. Do Task 10 last.
