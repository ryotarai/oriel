# Resume Session Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `--resume` failing on restart for empty sessions, while preserving explicit resume intent across restarts.

**Architecture:** Three changes: (1) backend defers `claude_session_id` broadcast until session has conversation content, (2) backend validates JSONL exists before using `--resume`, (3) frontend saves resume intent immediately when user clicks Resume. Plus E2E tests and a `-state-db` flag for test isolation.

**Tech Stack:** Go, React/TypeScript, Playwright

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `cmd/oriel/main.go` | Modify | Add `-state-db` flag |
| `internal/conversation/watcher.go` | Modify | Export `SessionHasContent` helper |
| `internal/ws/handler.go` | Modify | Defer UUID broadcast; validate before `--resume` |
| `frontend/src/SessionPanel.tsx` | Modify | `sendResume` calls `onClaudeSessionId` immediately |
| `tests/e2e/package.json` | Create | Playwright dependencies |
| `tests/e2e/playwright.config.ts` | Create | Playwright config |
| `tests/e2e/helpers/server.ts` | Create | Start/stop Oriel server helper |
| `tests/e2e/resume.spec.ts` | Create | Three E2E test cases |

---

### Task 1: Add `-state-db` flag

**Files:**
- Modify: `cmd/oriel/main.go:26-31`

- [ ] **Step 1: Add the flag and wire it**

In `cmd/oriel/main.go`, add a `-state-db` flag with default `""` (meaning use `state.DefaultPath()`):

```go
stateDB := flag.String("state-db", "", "Path to state database (default: ~/.config/oriel/state.sqlite3)")
```

Then change the `state.Open` call (line 31):

```go
dbPath := *stateDB
if dbPath == "" {
    dbPath = state.DefaultPath()
}
store, err := state.Open(dbPath)
```

- [ ] **Step 2: Build and verify**

Run: `go build ./cmd/oriel/`
Expected: builds without error.

Run: `./bin/oriel -help 2>&1 | grep state-db`
Expected: shows the flag description.

- [ ] **Step 3: Commit**

```bash
git add cmd/oriel/main.go
git commit -m "Add -state-db flag for test-configurable state database"
```

---

### Task 2: Add `SessionHasContent` helper

**Files:**
- Modify: `internal/conversation/watcher.go`

- [ ] **Step 1: Add the helper function**

Add after the `ReadSessionEntries` function (after line 103):

```go
// SessionHasContent checks whether a session's JSONL conversation file exists
// and contains at least one entry. Used to validate --resume targets.
func SessionHasContent(cwd, sessionID string) bool {
	projDir := projectDir(cwd)
	jsonlPath := filepath.Join(projDir, sessionID+".jsonl")
	info, err := os.Stat(jsonlPath)
	if err != nil || info.Size() == 0 {
		return false
	}
	return true
}
```

- [ ] **Step 2: Build**

Run: `go build ./...`
Expected: builds without error.

- [ ] **Step 3: Commit**

```bash
git add internal/conversation/watcher.go
git commit -m "Add SessionHasContent helper for validating resume targets"
```

---

### Task 3: Backend — validate before `--resume` and defer UUID broadcast

**Files:**
- Modify: `internal/ws/handler.go:107-150` (getOrCreateSession)
- Modify: `internal/ws/handler.go:297-337` (watchConversation)

- [ ] **Step 1: Validate JSONL in `getOrCreateSession`**

In `getOrCreateSession`, change the resume block (lines 129-138) to validate the session has content:

```go
	// If resuming a previous Claude session, pass --resume flag
	var args []string
	if resumeID != "" && conversation.SessionHasContent(cwd, resumeID) {
		args = []string{"--resume", resumeID}
		// Pre-load conversation history from the old session
		oldEntries := conversation.ReadSessionEntries(cwd, resumeID)
		if len(oldEntries) > 0 {
			s.convHistory = append(s.convHistory, oldEntries...)
		}
	}
```

The only change: add `&& conversation.SessionHasContent(cwd, resumeID)` to the condition.

- [ ] **Step 2: Apply same validation in `restartLoop`**

In `restartLoop` (lines 198-218), apply the same validation to both the conversation history loading and the `--resume` arg:

```go
		// If resuming, load the old session's conversation entries
		if req.resumeSessionID != "" && conversation.SessionHasContent(cwd, req.resumeSessionID) {
			oldEntries := conversation.ReadSessionEntries(cwd, req.resumeSessionID)
			if len(oldEntries) > 0 {
				s.mu.Lock()
				s.convHistory = append(s.convHistory, oldEntries...)
				s.mu.Unlock()
				for _, entry := range oldEntries {
					entryJSON, err := json.Marshal(entry)
					if err != nil {
						continue
					}
					h.broadcast(s, message{Type: "conversation", Entry: entryJSON})
				}
			}
		}

		// Start new process
		var args []string
		if req.resumeSessionID != "" && conversation.SessionHasContent(cwd, req.resumeSessionID) {
			args = []string{"--resume", req.resumeSessionID}
		}
```

- [ ] **Step 3: Defer UUID broadcast in `watchConversation`**

Replace the entire `watchConversation` method (lines 297-337) with:

```go
func (h *Handler) watchConversation(s *session) {
	s.mu.Lock()
	pid := s.pty.Pid()
	done := s.pty.Done()
	s.mu.Unlock()

	convCh := make(chan conversation.ConversationEntry, 64)
	go conversation.WatchSession(pid, convCh, done, func(uuid string) {
		log.Printf("Session %s: discovered Claude session UUID %s", s.id, uuid)
		s.mu.Lock()
		s.claudeSessionID = uuid
		s.mu.Unlock()
		// Don't broadcast yet — wait until the session has conversation content
		// so that empty sessions don't get a claudeSessionId saved to DB.
	})

	uuidBroadcast := false

	for {
		select {
		case entry, ok := <-convCh:
			if !ok {
				return
			}
			if entry.Type == "reset" {
				s.mu.Lock()
				s.convHistory = nil
				s.mu.Unlock()
				h.broadcast(s, message{Type: "conversation_reset"})
				continue
			}
			entryJSON, err := json.Marshal(entry)
			if err != nil {
				continue
			}
			s.mu.Lock()
			s.convHistory = append(s.convHistory, entry)
			s.mu.Unlock()
			h.broadcast(s, message{Type: "conversation", Entry: entryJSON})

			// After first real conversation entry, broadcast the UUID
			if !uuidBroadcast {
				s.mu.Lock()
				uuid := s.claudeSessionID
				s.mu.Unlock()
				if uuid != "" {
					h.broadcast(s, message{Type: "claude_session_id", Data: uuid})
					uuidBroadcast = true
				}
			}
		case <-done:
			return
		}
	}
}
```

- [ ] **Step 4: Build**

Run: `go build ./...`
Expected: builds without error.

- [ ] **Step 5: Commit**

```bash
git add internal/ws/handler.go
git commit -m "Validate resume target and defer UUID broadcast until session has content"
```

---

### Task 4: Frontend — save resume intent immediately

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:150-156`

- [ ] **Step 1: Update `sendResume` to call `onClaudeSessionId`**

Change the `sendResume` callback (lines 150-156). It currently only sends the WebSocket message. Add a call to `onClaudeSessionIdRef` so the target session ID is saved to DB immediately:

```typescript
  const sendResume = useCallback((targetSessionId: string) => {
    // Save the resume target to DB immediately so it persists across restarts
    onClaudeSessionIdRef.current?.(targetSessionId);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resume", data: targetSessionId }));
    }
    setShowResumeModal(false);
  }, []);
```

- [ ] **Step 2: Build frontend**

Run: `cd frontend && npm run build`
Expected: builds without error.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Save resume intent to DB immediately on explicit resume"
```

---

### Task 5: Playwright test infrastructure

**Files:**
- Create: `tests/e2e/package.json`
- Create: `tests/e2e/playwright.config.ts`
- Create: `tests/e2e/helpers/server.ts`

- [ ] **Step 1: Create `tests/e2e/package.json`**

```json
{
  "name": "oriel-e2e",
  "private": true,
  "scripts": {
    "test": "playwright test",
    "test:headed": "playwright test --headed"
  },
  "devDependencies": {
    "@playwright/test": "^1.52.0"
  }
}
```

- [ ] **Step 2: Create `tests/e2e/playwright.config.ts`**

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:0", // overridden per-test
  },
});
```

- [ ] **Step 3: Create `tests/e2e/helpers/server.ts`**

This helper starts/stops the Oriel server and provides the URL.

```typescript
import { type ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as net from "net";

export interface OrielServer {
  url: string;
  port: number;
  token: string;
  stateDbPath: string;
  stop: () => Promise<void>;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("Could not get free port"));
      }
    });
  });
}

export async function startOriel(opts?: {
  stateDbPath?: string;
}): Promise<OrielServer> {
  const stateDbPath =
    opts?.stateDbPath ??
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oriel-test-")), "state.db");

  const port = await getFreePort();
  const addr = `127.0.0.1:${port}`;

  // Build first (assumes binary exists at bin/oriel or project root)
  const binPath = path.resolve(__dirname, "../../../bin/oriel");
  if (!fs.existsSync(binPath)) {
    throw new Error(`Oriel binary not found at ${binPath}. Run 'make build' first.`);
  }

  let token = "";

  const proc: ChildProcess = spawn(binPath, [
    "-listen-addr", addr,
    "-state-db", stateDbPath,
    "-no-open",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Capture token from stderr log output
  const tokenPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Oriel did not start within 15s")), 15_000);

    const onData = (data: Buffer) => {
      const line = data.toString();
      // Log line: "Open http://127.0.0.1:PORT/?token=TOKEN"
      const match = line.match(/token=([a-f0-9]+)/);
      if (match) {
        token = match[1];
        clearTimeout(timeout);
        resolve(token);
      }
    };
    proc.stderr?.on("data", onData);
    proc.stdout?.on("data", onData);
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    proc.on("exit", (code) => {
      if (!token) { clearTimeout(timeout); reject(new Error(`Oriel exited with code ${code}`)); }
    });
  });

  token = await tokenPromise;
  const url = `http://${addr}/?token=${token}`;

  return {
    url,
    port,
    token,
    stateDbPath,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5000);
          proc.on("exit", () => { clearTimeout(t); resolve(); });
        });
      }
    },
  };
}
```

- [ ] **Step 4: Install dependencies and verify**

Run:
```bash
cd tests/e2e && npm install && npx playwright install chromium
```

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/package.json tests/e2e/playwright.config.ts tests/e2e/helpers/server.ts
git commit -m "Add Playwright E2E test infrastructure"
```

---

### Task 6: E2E tests for the three resume scenarios

**Files:**
- Create: `tests/e2e/resume.spec.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { test, expect, type Page } from "@playwright/test";
import { startOriel, type OrielServer } from "./helpers/server";

// Helper: wait until the xterm terminal has rendered some text
async function waitForTerminalText(page: Page, timeout = 30_000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => {
      // Access xterm buffer via the DOM — xterm renders rows as divs with class xterm-rows
      const rows = document.querySelectorAll(".xterm-rows > div");
      return Array.from(rows).map((r) => r.textContent ?? "").join("\n");
    });
    if (text.trim().length > 0) return text;
    await page.waitForTimeout(500);
  }
  throw new Error("Terminal did not render text within timeout");
}

async function getTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(".xterm-rows > div");
    return Array.from(rows).map((r) => r.textContent ?? "").join("\n");
  });
}

test.describe("Resume session across restarts", () => {
  let server: OrielServer;

  test.afterEach(async () => {
    await server?.stop();
  });

  test("new tab with no messages: restart should start fresh (no resume error)", async ({ browser }) => {
    // Start server, open page, wait for Claude to initialize
    server = await startOriel();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Wait a few seconds for watchConversation to discover UUID
    await page.waitForTimeout(5000);

    // Stop server
    await server.stop();

    // Restart with same DB
    server = await startOriel({ stateDbPath: server.stateDbPath });
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Wait for any error to appear
    await page.waitForTimeout(5000);
    const text = await getTerminalText(page);
    expect(text).not.toContain("No conversation found with session ID");

    await context.close();
  });

  test("send a message then restart: should resume correctly", async ({ browser }) => {
    server = await startOriel();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Type a short message and send it (Ctrl+J is newline, Enter submits by default)
    // Focus the terminal first
    await page.click(".xterm-helper-textarea", { force: true });
    await page.keyboard.type("hello, just testing", { delay: 30 });
    await page.keyboard.press("Enter");

    // Wait for Claude to respond (conversation entry appears)
    await page.waitForTimeout(15_000);

    // Stop server
    const dbPath = server.stateDbPath;
    await server.stop();

    // Restart with same DB
    server = await startOriel({ stateDbPath: dbPath });
    await page.goto(server.url);
    await waitForTerminalText(page);

    await page.waitForTimeout(5000);
    const text = await getTerminalText(page);
    expect(text).not.toContain("No conversation found with session ID");

    await context.close();
  });

  test("resume a session then restart: should preserve resume target", async ({ browser }) => {
    // Phase 1: Create a session with content
    server = await startOriel();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Send a message to create conversation content
    await page.click(".xterm-helper-textarea", { force: true });
    await page.keyboard.type("say hi", { delay: 30 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(15_000);

    // Stop server to end the session
    const dbPath = server.stateDbPath;
    await server.stop();

    // Phase 2: Restart, create a NEW tab, resume the previous session from that tab
    server = await startOriel({ stateDbPath: dbPath });
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Add a new tab
    await page.click('button[title="Add tab"]');
    await page.waitForTimeout(2000);

    // Click the resume button (↻) in the new tab's pane
    await page.click('button[title="Resume session"]');
    await page.waitForTimeout(2000);

    // Click the first session in the resume modal list
    const sessionItem = page.locator('[data-testid="session-item"]').first();
    if (await sessionItem.isVisible()) {
      await sessionItem.click();
    } else {
      // Fallback: click any clickable item in the modal
      const modalItem = page.locator(".fixed.inset-0 button").filter({ hasNotText: "×" }).first();
      await modalItem.click();
    }
    await page.waitForTimeout(10_000);

    // Phase 3: Stop and restart again — the resumed session should persist
    await server.stop();
    server = await startOriel({ stateDbPath: dbPath });
    await page.goto(server.url);

    // Switch to the second tab (Tab 2)
    const tab2 = page.locator("text=Tab 2");
    if (await tab2.isVisible()) {
      await tab2.click();
    }

    await waitForTerminalText(page);
    await page.waitForTimeout(5000);
    const text = await getTerminalText(page);
    expect(text).not.toContain("No conversation found with session ID");

    await context.close();
  });
});
```

- [ ] **Step 2: Build the Go binary (prerequisite)**

Run: `make build`
Expected: `bin/oriel` is created.

- [ ] **Step 3: Run the tests**

Run: `cd tests/e2e && npx playwright test --headed`
Expected: all 3 tests pass (the first two may already pass if the backend fix works; the third tests the resume-intent flow).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/resume.spec.ts
git commit -m "Add E2E tests for resume session across restarts"
```

---

### Task 7: Add E2E test target to Makefile

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Add test-e2e target**

Add after the existing `test-frontend` target:

```makefile
test-e2e: build
	cd tests/e2e && npx playwright test
```

Update the `test` target to include E2E:

```makefile
test: test-go test-frontend test-e2e
```

- [ ] **Step 2: Commit**

```bash
git add Makefile
git commit -m "Add test-e2e target to Makefile"
```
