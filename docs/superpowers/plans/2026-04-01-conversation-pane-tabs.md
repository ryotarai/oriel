# Conversation Pane Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Conversation/Diff tabs to the chat pane, where the Diff tab shows per-file unified diffs accumulated since session start.

**Architecture:** Backend captures HEAD commit at PTY start, serves per-file diff data via a new REST endpoint. Frontend adds a tab bar to the chat panel, with the existing conversation view under one tab and a new DiffPanel component (file list + diff sections) under the other. The diff auto-refreshes via polling every 3 seconds.

**Tech Stack:** Go (backend REST endpoint, git commands), React + TypeScript + Tailwind CSS (frontend)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `internal/diff/diff.go` | Git diff computation: capture start commit, compute per-file diffs |
| Modify | `internal/ws/handler.go` | Store `startCommit` on session, expose it for diff endpoint |
| Modify | `cmd/server/main.go` | Register `/api/diff` route |
| Create | `frontend/src/components/DiffPanel.tsx` | Diff tab UI: file tree + per-file diff sections |
| Modify | `frontend/src/SessionPanel.tsx` | Add tab bar, switch between Conversation/Diff tabs, poll diff API |

---

### Task 1: Backend — Git diff package

**Files:**
- Create: `internal/diff/diff.go`

- [ ] **Step 1: Create `internal/diff/diff.go` with types and `CaptureHead`**

```go
package diff

import (
	"os/exec"
	"strings"
)

// FileDiff represents a single file's diff data.
type FileDiff struct {
	Path   string  `json:"path"`
	Status string  `json:"status"` // "M", "A", "D"
	Diff   *string `json:"diff"`   // nil for binary files
}

// CaptureHead returns the current HEAD commit hash in the given directory.
// Returns empty string if the repo has no commits.
func CaptureHead(dir string) string {
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
```

- [ ] **Step 2: Add `ComputeDiff` function**

```go
// ComputeDiff returns per-file diffs between startCommit and the current working tree.
// If startCommit is empty, returns diffs of all tracked + untracked files.
func ComputeDiff(dir, startCommit string) ([]FileDiff, error) {
	var files []FileDiff

	if startCommit == "" {
		// No commits at session start — treat everything as new
		return diffNoBase(dir)
	}

	// Get changed files: git diff --name-status <startCommit>
	nsCmd := exec.Command("git", "diff", "--name-status", startCommit)
	nsCmd.Dir = dir
	nsOut, err := nsCmd.Output()
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(nsOut)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) < 2 {
			continue
		}
		status := string(parts[0][0]) // first char: M, A, D, R, etc.
		path := parts[1]
		if status == "R" {
			// Rename: "R100\told\tnew" — parts[1] is "old\tnew"
			rParts := strings.SplitN(path, "\t", 2)
			if len(rParts) == 2 {
				path = rParts[1]
			}
			status = "A"
		}
		seen[path] = true
		d := fileDiff(dir, startCommit, path)
		files = append(files, FileDiff{Path: path, Status: status, Diff: d})
	}

	// Untracked files
	utCmd := exec.Command("git", "ls-files", "--others", "--exclude-standard")
	utCmd.Dir = dir
	utOut, err := utCmd.Output()
	if err == nil {
		for _, path := range strings.Split(strings.TrimSpace(string(utOut)), "\n") {
			if path == "" || seen[path] {
				continue
			}
			content := readFileContent(dir, path)
			files = append(files, FileDiff{Path: path, Status: "A", Diff: content})
		}
	}

	return files, nil
}

func fileDiff(dir, startCommit, path string) *string {
	cmd := exec.Command("git", "diff", startCommit, "--", path)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	s := string(out)
	return &s
}

func readFileContent(dir, path string) *string {
	cmd := exec.Command("git", "show", ":"+path)
	cmd.Dir = dir
	// File is untracked, so git show won't work. Read from disk.
	data, err := os.ReadFile(filepath.Join(dir, path))
	if err != nil {
		return nil
	}
	// Check if binary (contains null bytes in first 8KB)
	check := data
	if len(check) > 8192 {
		check = check[:8192]
	}
	for _, b := range check {
		if b == 0 {
			return nil // binary
		}
	}
	// Format as unified diff "all added"
	lines := strings.Split(string(data), "\n")
	var buf strings.Builder
	buf.WriteString(fmt.Sprintf("--- /dev/null\n+++ b/%s\n", path))
	buf.WriteString(fmt.Sprintf("@@ -0,0 +1,%d @@\n", len(lines)))
	for _, l := range lines {
		buf.WriteString("+" + l + "\n")
	}
	s := buf.String()
	return &s
}

func diffNoBase(dir string) ([]FileDiff, error) {
	// List all tracked files as added
	cmd := exec.Command("git", "ls-files")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var files []FileDiff
	for _, path := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if path == "" {
			continue
		}
		content := readFileContent(dir, path)
		files = append(files, FileDiff{Path: path, Status: "A", Diff: content})
	}
	return files, nil
}
```

Note: add `"fmt"`, `"os"`, `"path/filepath"` to the import block.

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && go build ./internal/diff/`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add internal/diff/diff.go
git commit -m "Add internal/diff package for per-file git diff computation"
```

---

### Task 2: Backend — Store startCommit and add /api/diff endpoint

**Files:**
- Modify: `internal/ws/handler.go` — add `startCommit` and `cwd` fields to `session`, capture on start
- Modify: `cmd/server/main.go` — register `/api/diff` route

- [ ] **Step 1: Add `startCommit` and `cwd` fields to the session struct**

In `internal/ws/handler.go`, add two fields to the `session` struct:

```go
type session struct {
	id  string
	pty *ptylib.Session

	mu          sync.Mutex
	subs        map[*subscriber]struct{}
	convHistory []conversation.ConversationEntry
	exited      bool

	// Current terminal size (for restart)
	cols, rows uint16

	// Git state captured at session start
	startCommit string
	cwd         string

	// Signal channel: closed when the session needs to restart
	restartCh chan restartRequest
}
```

- [ ] **Step 2: Capture HEAD and cwd in `startProcess`**

In `startProcess`, after `ptylib.NewSession(...)` succeeds, capture the working directory and HEAD:

```go
func (h *Handler) startProcess(s *session, args ...string) error {
	ptySess, err := ptylib.NewSession(h.command, s.cols, s.rows, args...)
	if err != nil {
		return err
	}

	// Capture cwd and git HEAD for diff tracking
	cwd, _ := os.Getwd()

	s.mu.Lock()
	s.pty = ptySess
	s.exited = false
	s.cwd = cwd
	s.startCommit = diff.CaptureHead(cwd)
	s.mu.Unlock()

	go h.readPtyLoop(s)
	go h.watchConversation(s)

	return nil
}
```

Add the import: `"github.com/ryotarai/claude-code-wrapper-ui/internal/diff"` and `"os"`.

- [ ] **Step 3: Add `HandleDiff` method to Handler**

Add this method to `internal/ws/handler.go`:

```go
// HandleDiff returns per-file diff data for a session.
func (h *Handler) HandleDiff(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session")
	if sessionID == "" {
		sessionID = "default"
	}

	h.mu.Lock()
	s, ok := h.sessions[sessionID]
	h.mu.Unlock()

	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	s.mu.Lock()
	startCommit := s.startCommit
	cwd := s.cwd
	s.mu.Unlock()

	files, err := diff.ComputeDiff(cwd, startCommit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"files": files,
	})
}
```

Add `"encoding/json"` to imports if not already there (it is).

- [ ] **Step 4: Register the route in main.go**

In `cmd/server/main.go`, add the diff endpoint:

```go
mux.HandleFunc("/api/diff", handler.HandleDiff)
```

Add it after the existing `/api/sessions` line.

- [ ] **Step 5: Verify it compiles**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && go build ./cmd/server/`
Expected: no errors

- [ ] **Step 6: Run existing tests**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && go test ./... -v -count=1`
Expected: all existing tests pass

- [ ] **Step 7: Commit**

```bash
git add internal/ws/handler.go cmd/server/main.go
git commit -m "Add /api/diff endpoint with start-commit tracking"
```

---

### Task 3: Frontend — DiffPanel component

**Files:**
- Create: `frontend/src/components/DiffPanel.tsx`

- [ ] **Step 1: Create DiffPanel component with types and layout**

Create `frontend/src/components/DiffPanel.tsx`:

```tsx
import { useRef, useCallback } from "react";

export interface FileDiffData {
  path: string;
  status: string; // "M", "A", "D"
  diff: string | null;
}

interface DiffPanelProps {
  files: FileDiffData[];
}

function statusColor(status: string): string {
  switch (status) {
    case "A": return "text-green-400";
    case "D": return "text-red-400";
    case "M": return "text-yellow-400";
    default:  return "text-gray-400";
  }
}

function statusBgColor(status: string): string {
  switch (status) {
    case "A": return "bg-green-900/40 text-green-400";
    case "D": return "bg-red-900/40 text-red-400";
    case "M": return "bg-yellow-900/40 text-yellow-400";
    default:  return "bg-gray-800 text-gray-400";
  }
}

export function DiffPanel({ files }: DiffPanelProps) {
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const scrollToFile = useCallback((path: string) => {
    const el = sectionRefs.current.get(path);
    if (el && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: el.offsetTop - scrollContainerRef.current.offsetTop,
        behavior: "smooth",
      });
    }
  }, []);

  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        No changes yet
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* File tree (left) */}
      <div className="w-60 flex-shrink-0 border-r border-gray-800 overflow-y-auto">
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => scrollToFile(f.path)}
            className="w-full text-left px-3 py-1.5 hover:bg-gray-800/60 text-xs font-mono flex items-center gap-2 transition-colors"
          >
            <span className={`font-bold flex-shrink-0 w-4 text-center ${statusColor(f.status)}`}>
              {f.status}
            </span>
            <span className="text-gray-500 truncate">
              {f.path.includes("/") ? f.path.substring(0, f.path.lastIndexOf("/") + 1) : ""}
              <span className="text-gray-200">
                {f.path.includes("/") ? f.path.substring(f.path.lastIndexOf("/") + 1) : f.path}
              </span>
            </span>
          </button>
        ))}
      </div>

      {/* Diff sections (right) */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {files.map((f) => (
          <div
            key={f.path}
            ref={(el) => { if (el) sectionRefs.current.set(f.path, el); }}
          >
            {/* File header */}
            <div className="sticky top-0 z-10 bg-gray-900/95 backdrop-blur-sm border-b border-gray-800 px-4 py-2 flex items-center gap-2">
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${statusBgColor(f.status)}`}>
                {f.status}
              </span>
              <span className="text-sm font-mono text-gray-200">{f.path}</span>
            </div>
            {/* Diff content */}
            {f.diff ? (
              <DiffBlock diff={f.diff} />
            ) : (
              <div className="px-4 py-3 text-gray-500 text-xs italic">Binary file</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="text-xs font-mono leading-5 px-0 py-1">
      {lines.map((line, i) => {
        let className = "px-4 ";
        if (line.startsWith("+++ ") || line.startsWith("--- ")) {
          className += "text-gray-500";
        } else if (line.startsWith("@@")) {
          className += "text-blue-400 bg-blue-900/20";
        } else if (line.startsWith("+")) {
          className += "text-green-300 bg-green-900/20";
        } else if (line.startsWith("-")) {
          className += "text-red-300 bg-red-900/20";
        } else if (line.startsWith("diff --git")) {
          return null; // skip diff header lines
        } else if (line.startsWith("index ")) {
          return null; // skip index lines
        } else {
          className += "text-gray-400";
        }

        return (
          <div key={i} className={className}>
            {line || "\u00a0"}
          </div>
        );
      })}
    </pre>
  );
}
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/DiffPanel.tsx
git commit -m "Add DiffPanel component with file tree and unified diff view"
```

---

### Task 4: Frontend — Add tabs to SessionPanel and integrate DiffPanel

**Files:**
- Modify: `frontend/src/SessionPanel.tsx`

- [ ] **Step 1: Add imports and state for tabs and diff polling**

At the top of `SessionPanel.tsx`, add the import:

```tsx
import { DiffPanel, type FileDiffData } from "./components/DiffPanel";
```

Inside the `SessionPanel` component, add these state variables after the existing `splitPct` state:

```tsx
const [activeTab, setActiveTab] = useState<"conversation" | "diff">("conversation");
const [diffFiles, setDiffFiles] = useState<FileDiffData[]>([]);
```

- [ ] **Step 2: Add diff polling effect**

Add this `useEffect` after the auto-scroll effect:

```tsx
// Poll diff API
useEffect(() => {
  const poll = () => {
    fetch(`/api/diff?session=${encodeURIComponent(sessionId)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.files) setDiffFiles(data.files);
      })
      .catch(() => {});
  };
  poll();
  const id = setInterval(poll, 3000);
  return () => clearInterval(id);
}, [sessionId]);
```

- [ ] **Step 3: Replace the chat panel JSX with tabbed layout**

Replace the `{/* Chat panel (top) */}` section (the first child div inside the return's root div, lines ~192-217) with:

```tsx
{/* Chat panel (top) */}
<div
  style={{ height: `${splitPct}%` }}
  className="flex flex-col min-h-0"
>
  {/* Tab bar */}
  <div className="flex-shrink-0 flex border-b border-gray-800 bg-gray-900/50">
    <button
      onClick={() => setActiveTab("conversation")}
      className={`px-4 py-2 text-xs font-medium transition-colors ${
        activeTab === "conversation"
          ? "text-gray-100 border-b-2 border-blue-500"
          : "text-gray-500 hover:text-gray-300"
      }`}
    >
      Conversation
    </button>
    <button
      onClick={() => setActiveTab("diff")}
      className={`px-4 py-2 text-xs font-medium transition-colors ${
        activeTab === "diff"
          ? "text-gray-100 border-b-2 border-blue-500"
          : "text-gray-500 hover:text-gray-300"
      }`}
    >
      Diff
      {diffFiles.length > 0 && (
        <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-300 text-[10px]">
          {diffFiles.length}
        </span>
      )}
    </button>
  </div>

  {/* Tab content */}
  {activeTab === "conversation" ? (
    <div
      className="flex-1 overflow-y-auto p-3 space-y-3 flex flex-col min-h-0 cursor-text"
      onClick={() => {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        termRef.current?.focus();
      }}
    >
      <div className="flex flex-col space-y-3 mt-auto">
        {!connected && (
          <div className="text-center text-yellow-400 text-sm">Connecting...</div>
        )}
        {entries.length === 0 && connected && (
          <div className="text-gray-600 text-sm text-center mt-4">
            Messages will appear here...
          </div>
        )}
        {entries.map((entry) => (
          <MessageBubble key={entry.uuid} entry={entry} />
        ))}
        <div ref={chatEndRef} />
      </div>
    </div>
  ) : (
    <div className="flex-1 flex flex-col min-h-0">
      <DiffPanel files={diffFiles} />
    </div>
  )}
</div>
```

- [ ] **Step 4: Verify frontend compiles**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Build full project**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && make build`
Expected: build succeeds

- [ ] **Step 6: Run all tests**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && make test`
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Add Conversation/Diff tabs to session panel with auto-refresh"
```
