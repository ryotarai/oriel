# Reply Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Claude session completes (assistant sends final text response), automatically generate reply suggestions and show them as clickable buttons so the user can respond with one click.

**Architecture:** The backend detects session completion via the existing `exit` broadcast in `readPtyLoop()`. A new `"request_suggestions"` WebSocket message type lets the frontend request suggestions when it detects the session is idle (last entry is assistant text). The backend spawns `claude --resume SESSION_ID --fork-session -p --output-format json --json-schema '...'` to generate suggestions, then broadcasts them as a `"suggestions"` message. The frontend renders these as buttons below the last message; clicking a button types the message into the terminal and sends Enter.

**Tech Stack:** Go (backend, exec.Command), TypeScript/React (frontend), claude CLI

---

### Task 1: Backend — Add suggestion generation endpoint

**Files:**
- Create: `internal/ws/suggestions.go`
- Modify: `internal/ws/handler.go`

This task adds the Go function that calls the claude CLI to generate suggestions, and a new WebSocket message type `"request_suggestions"` that the frontend can send to trigger it.

- [ ] **Step 1: Create `internal/ws/suggestions.go` with the suggestion generation function**

```go
package ws

import (
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"time"
)

type suggestion struct {
	Label   string `json:"label"`
	Message string `json:"message"`
}

type suggestionsResult struct {
	Suggestions []suggestion `json:"suggestions"`
}

const suggestionsJSONSchema = `{"type":"object","properties":{"suggestions":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string","description":"Short button label (under 40 chars)"},"message":{"type":"string","description":"Full message to send"}},"required":["label","message"]},"minItems":3,"maxItems":5}},"required":["suggestions"]}`

const suggestionsPrompt = "Based on the conversation so far, suggest 3-5 possible next messages the user might want to send. Focus on natural follow-up actions like asking for refinements, requesting tests, committing changes, or exploring related topics. Keep labels short and messages actionable. Return ONLY the JSON."

// generateSuggestions calls claude CLI to generate reply suggestions for a session.
// It runs with a 30-second timeout and returns the parsed suggestions.
func (h *Handler) generateSuggestions(claudeSessionID string) ([]suggestion, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, h.command,
		"--resume", claudeSessionID,
		"--fork-session",
		"-p",
		"--output-format", "json",
		"--json-schema", suggestionsJSONSchema,
		"--no-session-persistence",
		suggestionsPrompt,
	)

	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("claude CLI failed: %w", err)
	}

	// Parse the JSON output — the structured_output field contains our data
	var result struct {
		StructuredOutput suggestionsResult `json:"structured_output"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, fmt.Errorf("parse suggestions: %w", err)
	}

	return result.StructuredOutput.Suggestions, nil
}
```

Note: Add `"context"` to the imports.

- [ ] **Step 2: Add `"request_suggestions"` handler in `handler.go`**

In `handler.go`, inside the `switch msg.Type` block (around line 605), add a new case:

```go
		case "request_suggestions":
			// Generate reply suggestions in a background goroutine
			s.mu.Lock()
			claudeSessionID := s.claudeSessionID
			s.mu.Unlock()
			if claudeSessionID == "" {
				sub.writeJSON(message{Type: "suggestions_error", Data: "no session ID"})
				continue
			}
			go func() {
				suggestions, err := h.generateSuggestions(claudeSessionID)
				if err != nil {
					log.Printf("Session %s: suggestions failed: %v", s.id, err)
					sub.writeJSON(message{Type: "suggestions_error", Data: err.Error()})
					return
				}
				data, _ := json.Marshal(suggestions)
				sub.writeJSON(message{Type: "suggestions", Data: string(data)})
			}()
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && go build ./...
```

- [ ] **Step 4: Commit**

```bash
git add internal/ws/suggestions.go internal/ws/handler.go
git commit -m "Add reply suggestion generation via claude CLI"
```

---

### Task 2: Frontend — Request suggestions on session idle and render buttons

**Files:**
- Modify: `frontend/src/SessionPanel.tsx`

This task adds the frontend logic: when the session becomes idle (last entry is assistant text), automatically send `request_suggestions` over WebSocket, then render the returned suggestions as clickable buttons. Clicking a button types the message and sends Enter.

- [ ] **Step 1: Add state for suggestions**

In `SessionPanel`, after the `running` state declaration (line 97), add:

```typescript
const [suggestions, setSuggestions] = useState<{ label: string; message: string }[]>([]);
const [suggestionsLoading, setSuggestionsLoading] = useState(false);
```

- [ ] **Step 2: Handle `suggestions` and `suggestions_error` WebSocket messages**

In the `ws.onmessage` handler (around line 207), add cases for the new message types:

```typescript
      } else if (msg.type === "suggestions") {
        try {
          const parsed = JSON.parse(msg.data);
          setSuggestions(parsed);
        } catch {}
        setSuggestionsLoading(false);
      } else if (msg.type === "suggestions_error") {
        setSuggestionsLoading(false);
      }
```

- [ ] **Step 3: Auto-request suggestions when session becomes idle**

Add a `useEffect` that watches `running` and requests suggestions when it transitions to `false`:

```typescript
  // Request reply suggestions when session becomes idle
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;

    if (wasRunning && !running && entries.length > 0) {
      // Session just finished — request suggestions
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        setSuggestions([]);
        setSuggestionsLoading(true);
        ws.send(JSON.stringify({ type: "request_suggestions" }));
      }
    }
  }, [running, entries.length]);

  // Clear suggestions when user sends a new message (session becomes running again)
  useEffect(() => {
    if (running) {
      setSuggestions([]);
      setSuggestionsLoading(false);
    }
  }, [running]);
```

- [ ] **Step 4: Render suggestion buttons in the conversation view**

After the `<div ref={chatEndRef} />` line (line 554), add the suggestion buttons:

```tsx
              {/* Reply suggestions */}
              {suggestionsLoading && (
                <div className="flex gap-2 flex-wrap px-1">
                  <span className="text-xs text-gray-500 animate-pulse">Generating suggestions...</span>
                </div>
              )}
              {suggestions.length > 0 && !running && (
                <div className="flex gap-2 flex-wrap px-1 pb-1">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        sendInputToTerminal(s.message + "\r");
                        setSuggestions([]);
                      }}
                      className="text-xs px-3 py-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 hover:border-blue-500/50 transition-colors cursor-pointer"
                      title={s.message}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
```

The `title` attribute shows the full message on hover. Clicking sends the message text + `\r` (carriage return = Enter) to the terminal, which submits it to claude. Note: if swap-enter is enabled, the user's terminal uses `\n` for newlines and Cmd+Enter for submit. However, the suggestion click should always submit immediately, so we send the raw message followed by `\r` which is the actual Enter key for the PTY.

- [ ] **Step 5: Verify frontend compiles**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Add reply suggestion buttons to conversation tab"
```

---

### Task 3: End-to-end testing and polish

**Files:**
- Possibly modify: `internal/ws/suggestions.go`, `frontend/src/SessionPanel.tsx`

- [ ] **Step 1: Manual E2E test**

1. Start Oriel: `go run ./cmd/oriel`
2. Open browser, send a message to Claude
3. Wait for Claude to respond
4. Verify "Generating suggestions..." appears briefly
5. Verify suggestion buttons appear below the last message
6. Click a suggestion button — verify the message is typed and sent
7. Verify suggestions disappear when Claude starts processing

- [ ] **Step 2: Edge case — handle swap-enter mode**

When swap-enter is enabled, the terminal expects `\n` for newlines within the message, but the actual submit is still `\r` (carriage return). The `sendInputToTerminal(s.message + "\r")` approach sends raw text to the PTY, bypassing the xterm key handler entirely — so it should work regardless of swap-enter setting. Verify this works correctly.

If the message contains newlines, they should be sent as `\n` characters. The final `\r` triggers submit. This should already work because `sendInputToTerminal` sends raw bytes.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "Fix reply suggestion edge cases"
```
