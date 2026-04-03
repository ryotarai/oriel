# idle_prompt Hook-Based Reply Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current frontend-triggered suggestion generation with Claude Code's `idle_prompt` Notification hook, so suggestions are automatically triggered when Claude becomes idle.

**Architecture:** When oriel spawns a Claude CLI process, it injects a `--settings` flag containing a Notification hook that POSTs to `http://localhost:{port}/api/sessions/{orielSessionID}/idle?token={token}` on `idle_prompt`. The new HTTP endpoint extracts `session_id` (Claude's session UUID) and `cwd` from the hook payload, generates suggestions via the existing `generateSuggestions` method, and broadcasts them to all WebSocket subscribers. The frontend's `request_suggestions` sending logic is removed; it only receives and displays suggestions.

**Tech Stack:** Go (net/http, encoding/json), TypeScript/React (frontend)

---

### Task 1: Add listenAddr and token fields to Handler

**Files:**
- Modify: `internal/ws/handler.go:108-121` (Handler struct and NewHandler)
- Modify: `cmd/oriel/main.go:87` (NewHandler call)

- [ ] **Step 1: Add fields to Handler struct and update NewHandler**

In `internal/ws/handler.go`, add `listenAddr` and `token` to the `Handler` struct:

```go
type Handler struct {
	command    string
	listenAddr string
	token      string
	store      *state.Store
	mu         sync.Mutex
	sessions   map[string]*session
}

func NewHandler(command string, listenAddr string, token string, store *state.Store) *Handler {
	return &Handler{
		command:    command,
		listenAddr: listenAddr,
		token:      token,
		store:      store,
		sessions:   make(map[string]*session),
	}
}
```

- [ ] **Step 2: Update the NewHandler call in main.go**

In `cmd/oriel/main.go`, change line 87:

```go
handler := ws.NewHandler(*command, *listenAddr, token, store)
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel && go build ./...`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add internal/ws/handler.go cmd/oriel/main.go
git commit -m "feat: add listenAddr and token fields to Handler for hook URL generation"
```

---

### Task 2: Inject `--settings` with idle_prompt hook when spawning Claude CLI

**Files:**
- Modify: `internal/ws/handler.go:170-194` (startProcess method)

The `startProcess` method currently builds args with `--append-system-prompt`. We add `--settings` with a JSON string containing the Notification hook configuration pointing to `http://{listenAddr}/api/sessions/{sessionID}/idle?token={token}`.

- [ ] **Step 1: Build the settings JSON in startProcess**

In `internal/ws/handler.go`, modify `startProcess` to construct and inject the `--settings` flag:

```go
func (h *Handler) startProcess(s *session, args ...string) error {
	s.mu.Lock()
	cwd := s.cwd
	s.worktreeDir = "" // reset on process start
	s.mu.Unlock()

	allArgs := []string{"--append-system-prompt", appendSystemPrompt}

	// Inject idle_prompt Notification hook via --settings
	idleURL := fmt.Sprintf("http://%s/api/sessions/%s/idle?token=%s", h.listenAddr, s.id, h.token)
	settingsJSON := fmt.Sprintf(`{"hooks":{"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"http","url":"%s"}]}]}}`, idleURL)
	allArgs = append(allArgs, "--settings", settingsJSON)

	allArgs = append(allArgs, args...)

	ptySess, err := ptylib.NewSession(h.command, s.cols, s.rows, cwd, allArgs...)
	if err != nil {
		return err
	}

	s.mu.Lock()
	s.pty = ptySess
	s.exited = false
	s.mu.Unlock()

	go h.readPtyLoop(s)
	go h.watchConversation(s)
	go h.startFileWatcher(s, ptySess.Done())

	return nil
}
```

- [ ] **Step 2: Add "fmt" to imports if not already present**

Check the imports in `handler.go`. If `"fmt"` is not in the import list, add it. (It's likely already there since `startProcess` didn't use it before but other code may. Check and add if needed.)

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel && go build ./...`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add internal/ws/handler.go
git commit -m "feat: inject idle_prompt Notification hook via --settings when spawning Claude CLI"
```

---

### Task 3: Add `HandleIdle` HTTP endpoint

**Files:**
- Modify: `internal/ws/handler.go` (add HandleIdle method)
- Modify: `cmd/oriel/main.go:97-109` (register new route)

- [ ] **Step 1: Add HandleIdle method to Handler**

In `internal/ws/handler.go`, add the `HandleIdle` method. This handler:
1. Extracts the session ID from the URL path
2. Parses the hook payload to get `session_id` (Claude's session UUID) and `cwd`
3. Calls `generateSuggestions`
4. Broadcasts the result to all WebSocket subscribers

```go
// HandleIdle is called by Claude Code's idle_prompt Notification hook.
// It triggers reply suggestion generation and broadcasts results via WebSocket.
func (h *Handler) HandleIdle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract oriel session ID from URL path: /api/sessions/{id}/idle
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 4 || parts[0] != "api" || parts[1] != "sessions" || parts[3] != "idle" {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	sessionID := parts[2]

	// Parse hook payload
	var payload struct {
		SessionID string `json:"session_id"`
		CWD       string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}

	h.mu.Lock()
	s, ok := h.sessions[sessionID]
	h.mu.Unlock()
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	// Return 200 immediately to not block Claude Code's hook
	w.WriteHeader(http.StatusOK)

	// Generate suggestions in background and broadcast to subscribers
	go func() {
		claudeSessionID := payload.SessionID
		sessionCwd := payload.CWD
		if claudeSessionID == "" || sessionCwd == "" {
			s.mu.Lock()
			if claudeSessionID == "" {
				claudeSessionID = s.claudeSessionID
			}
			if sessionCwd == "" {
				sessionCwd = s.cwd
			}
			s.mu.Unlock()
		}

		if claudeSessionID == "" {
			slog.Warn("Cannot generate suggestions: no Claude session ID", "session", sessionID)
			return
		}

		slog.Debug("Generating suggestions from idle_prompt hook", "session", sessionID, "claudeSession", claudeSessionID)

		suggestions, err := h.generateSuggestions(claudeSessionID, sessionCwd)
		if err != nil {
			slog.Warn("Suggestions generation failed", "session", sessionID, "error", err)
			h.broadcast(s, message{Type: "suggestions_error", Data: err.Error()})
			return
		}

		data, err := json.Marshal(suggestions)
		if err != nil {
			slog.Error("Failed to marshal suggestions", "session", sessionID, "error", err)
			return
		}
		h.broadcast(s, message{Type: "suggestions", Data: string(data)})
	}()
}
```

- [ ] **Step 2: Register the route in main.go**

In `cmd/oriel/main.go`, add the route after the existing `/api/sessions` route:

```go
mux.HandleFunc("/api/sessions", handler.HandleListSessions)
mux.HandleFunc("/api/sessions/", handler.HandleIdle) // idle_prompt hook endpoint
```

Note: The trailing `/` in `"/api/sessions/"` ensures it matches paths like `/api/sessions/abc/idle`. The handler validates the path structure internally.

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel && go build ./...`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add internal/ws/handler.go cmd/oriel/main.go
git commit -m "feat: add HandleIdle HTTP endpoint for idle_prompt hook-based suggestions"
```

---

### Task 4: Remove `request_suggestions` WebSocket handling from backend

**Files:**
- Modify: `internal/ws/handler.go:817-840` (remove request_suggestions case)

- [ ] **Step 1: Remove the `request_suggestions` case from the WebSocket message loop**

In `internal/ws/handler.go`, delete the entire `case "request_suggestions":` block (lines 817-840):

```go
// DELETE this entire block:
		case "request_suggestions":
			s.mu.Lock()
			claudeSessionID := s.claudeSessionID
			sessionCwd := s.cwd
			s.mu.Unlock()
			if claudeSessionID == "" {
				sub.writeJSON(message{Type: "suggestions_error", Data: "no session ID"})
				continue
			}
			go func() {
				suggestions, err := h.generateSuggestions(claudeSessionID, sessionCwd)
				if err != nil {
					slog.Warn("Suggestions generation failed", "session", s.id, "error", err)
					sub.writeJSON(message{Type: "suggestions_error", Data: err.Error()})
					return
				}
				data, err := json.Marshal(suggestions)
				if err != nil {
					slog.Error("Failed to marshal suggestions", "session", s.id, "error", err)
					sub.writeJSON(message{Type: "suggestions_error", Data: err.Error()})
					return
				}
				sub.writeJSON(message{Type: "suggestions", Data: string(data)})
			}()
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel && go build ./...`
Expected: Compiles successfully

- [ ] **Step 3: Commit**

```bash
git add internal/ws/handler.go
git commit -m "refactor: remove request_suggestions WebSocket handler (replaced by idle_prompt hook)"
```

---

### Task 5: Remove frontend suggestion request logic

**Files:**
- Modify: `frontend/src/SessionPanel.tsx`

The frontend currently:
1. Detects idle state via `running` flag
2. Sends `request_suggestions` WebSocket message after 2s debounce
3. Manages `suggestionsLoading` spinner with 30s timeout

With the hook approach, suggestions arrive automatically via `suggestions` WebSocket message. We need to:
- Remove the idle detection → request_suggestions sending logic
- Keep the `suggestions` and `suggestions_error` WebSocket message handlers (they already work)
- Show the loading spinner when the session transitions from running→idle (since we know hook will fire), and clear it when suggestions arrive or after 30s timeout
- Keep the `running` state detection (still useful for UI)

- [ ] **Step 1: Remove the request_suggestions sending logic**

Find the `useEffect` block that starts around line 476 with the comment "Request reply suggestions when session becomes idle". Replace it to just set the loading state without sending the WebSocket message:

```tsx
  // Show suggestions loading when session becomes idle (hook will auto-trigger)
  const prevRunningRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;

    if (wasRunning && !running && entries.length > 0) {
      // Debounce: wait 2s to confirm session is truly idle
      idleTimerRef.current = setTimeout(() => {
        setSuggestions([]);
        setSuggestionsLoading(true);
        // Safety timeout: stop spinner after 30s if no response from hook
        setTimeout(() => setSuggestionsLoading(false), 30000);
      }, 2000);
    }

    if (running) {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    }

    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [running]);
```

- [ ] **Step 2: Remove `suggestionsRequestedRef` state variable**

Remove the declaration of `suggestionsRequestedRef` (around line 479) and any remaining references to it. It's no longer needed since we don't track whether we've sent the request.

- [ ] **Step 3: Verify frontend builds**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel && npm run --prefix frontend build`
Expected: Builds successfully

- [ ] **Step 4: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "refactor: remove request_suggestions from frontend, rely on idle_prompt hook"
```

---

### Task 6: Manual integration test

**Files:** None (testing only)

- [ ] **Step 1: Build and run oriel**

```bash
cd /Users/r-arai/src/github.com/ryotarai/oriel
go build -o oriel . && ./oriel
```

- [ ] **Step 2: Verify Claude starts with hook settings**

Check the debug log at `~/.local/oriel/debug.log` for the `--settings` flag being passed. Or run with `-log-level debug` and look for the spawned command.

- [ ] **Step 3: Test the flow**

1. Open the oriel UI in browser
2. Send a message to Claude and wait for a response
3. After Claude responds and becomes idle, the `idle_prompt` hook should fire
4. Verify suggestions appear automatically in the UI without the user clicking anything
5. Verify the loading spinner shows while suggestions are being generated

- [ ] **Step 4: Verify edge cases**

1. Send another message while suggestions are loading — spinner should clear, suggestions should clear
2. `/clear` the session — new session should still get suggestions after idle
3. Open a second tab/pane — both should get suggestions independently
