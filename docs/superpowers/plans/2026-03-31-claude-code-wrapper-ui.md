# Claude Code Wrapper UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web app that wraps Claude Code's interactive pty in a browser with rich rendering (markdown, diffs, tool calls).

**Architecture:** Go backend spawns Claude Code via `creack/pty`, bridges to browser via WebSocket. React frontend uses a hidden xterm.js terminal to interpret ANSI output, reads the screen buffer, detects semantic patterns (headings, code blocks, diffs, tool calls), and renders them with custom React components. Unrecognized output falls back to styled terminal text.

**Tech Stack:** Go 1.26 (`creack/pty`, `gorilla/websocket`), React 19, Vite, TypeScript, xterm.js, Tailwind CSS, react-markdown, Vitest

---

## File Structure

```
claude-code-wrapper-ui/
├── cmd/server/main.go                    # HTTP server entry point
├── internal/pty/session.go               # pty lifecycle: start, read, write, resize, stop
├── internal/ws/handler.go                # WebSocket upgrade + message routing
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── src/
│   │   ├── main.tsx                      # React entry
│   │   ├── App.tsx                       # Top-level layout
│   │   ├── types.ts                      # Shared types (ScreenLine, Span, Block, etc.)
│   │   ├── hooks/useWebSocket.ts         # WS connection + reconnect logic
│   │   ├── terminal/HiddenTerminal.ts    # xterm.js headless wrapper (no React)
│   │   ├── terminal/BufferReader.ts      # Extract ScreenLine[] from xterm buffer
│   │   ├── terminal/PatternDetector.ts   # Detect semantic blocks from ScreenLine[]
│   │   ├── components/App.css            # Global styles
│   │   ├── components/WelcomeCard.tsx
│   │   ├── components/UserMessage.tsx
│   │   ├── components/AssistantMessage.tsx
│   │   ├── components/CodeBlock.tsx
│   │   ├── components/ToolCallCard.tsx
│   │   ├── components/DiffView.tsx
│   │   ├── components/SpinnerIndicator.tsx
│   │   ├── components/StatusBar.tsx
│   │   ├── components/TerminalFallback.tsx
│   │   └── components/InputArea.tsx
│   └── tests/
│       ├── BufferReader.test.ts
│       └── PatternDetector.test.ts
```

---

### Task 1: Go Backend — pty Session Manager

**Files:**
- Create: `internal/pty/session.go`
- Create: `internal/pty/session_test.go`

- [ ] **Step 1: Write the test for Session lifecycle**

```go
// internal/pty/session_test.go
package pty_test

import (
	"bytes"
	"testing"
	"time"

	ptylib "github.com/ryotarai/claude-code-wrapper-ui/internal/pty"
)

func TestSession_StartAndWrite(t *testing.T) {
	// Use 'cat' as a simple echo process for testing
	s, err := ptylib.NewSession("cat", 80, 24)
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	defer s.Close()

	// Write to stdin
	if err := s.Write([]byte("hello\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Read from stdout — cat echoes back
	buf := make([]byte, 256)
	var out bytes.Buffer
	deadline := time.After(2 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatalf("Timed out waiting for output, got: %q", out.String())
		default:
		}
		n, err := s.Read(buf)
		if err != nil {
			break
		}
		out.Write(buf[:n])
		if bytes.Contains(out.Bytes(), []byte("hello")) {
			break
		}
	}

	if !bytes.Contains(out.Bytes(), []byte("hello")) {
		t.Errorf("Expected output to contain 'hello', got %q", out.String())
	}
}

func TestSession_Resize(t *testing.T) {
	s, err := ptylib.NewSession("cat", 80, 24)
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	defer s.Close()

	// Should not error
	if err := s.Resize(120, 40); err != nil {
		t.Errorf("Resize: %v", err)
	}
}

func TestSession_Close(t *testing.T) {
	s, err := ptylib.NewSession("cat", 80, 24)
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	if err := s.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}

	// Writing after close should fail
	err = s.Write([]byte("test"))
	if err == nil {
		t.Error("Expected error writing to closed session")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && go test ./internal/pty/ -v`
Expected: FAIL — package not found

- [ ] **Step 3: Implement Session**

```go
// internal/pty/session.go
package pty

import (
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

type Session struct {
	cmd  *exec.Cmd
	ptmx *os.File
	mu   sync.Mutex
	done bool
}

func NewSession(command string, cols, rows uint16) (*Session, error) {
	cmd := exec.Command(command)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("COLUMNS=%d", cols),
		fmt.Sprintf("LINES=%d", rows),
		"TERM=xterm-256color",
	)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}

	return &Session{cmd: cmd, ptmx: ptmx}, nil
}

func (s *Session) Read(buf []byte) (int, error) {
	return s.ptmx.Read(buf)
}

func (s *Session) Write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return fmt.Errorf("session closed")
	}
	_, err := s.ptmx.Write(data)
	return err
}

func (s *Session) Resize(cols, rows uint16) error {
	return pty.Setsize(s.ptmx, &pty.Winsize{Rows: rows, Cols: cols})
}

func (s *Session) Close() error {
	s.mu.Lock()
	s.done = true
	s.mu.Unlock()

	s.ptmx.Close()
	return s.cmd.Wait()
}

func (s *Session) Done() <-chan struct{} {
	ch := make(chan struct{})
	go func() {
		s.cmd.Wait()
		close(ch)
	}()
	return ch
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/pty/ -v -count=1`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add internal/pty/
git commit -m "Add pty session manager with start, read, write, resize, close"
```

---

### Task 2: Go Backend — WebSocket Handler

**Files:**
- Create: `internal/ws/handler.go`
- Create: `internal/ws/handler_test.go`

- [ ] **Step 1: Install gorilla/websocket**

Run: `go get github.com/gorilla/websocket`

- [ ] **Step 2: Write the test**

```go
// internal/ws/handler_test.go
package ws_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	wslib "github.com/ryotarai/claude-code-wrapper-ui/internal/ws"
)

type wsMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

func TestHandler_EchoRoundTrip(t *testing.T) {
	h := wslib.NewHandler("cat")
	srv := httptest.NewServer(http.HandlerFunc(h.ServeHTTP))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	// Send input
	input := wsMessage{Type: "input", Data: base64.StdEncoding.EncodeToString([]byte("hello\r"))}
	if err := conn.WriteJSON(input); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}

	// Read output messages until we see "hello"
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	found := false
	for i := 0; i < 20; i++ {
		var msg wsMessage
		if err := conn.ReadJSON(&msg); err != nil {
			break
		}
		if msg.Type == "output" {
			decoded, _ := base64.StdEncoding.DecodeString(msg.Data)
			if strings.Contains(string(decoded), "hello") {
				found = true
				break
			}
		}
	}

	if !found {
		t.Error("Expected to receive 'hello' echoed back via output messages")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/ws/ -v -count=1`
Expected: FAIL — package not found

- [ ] **Step 4: Implement Handler**

```go
// internal/ws/handler.go
package ws

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
	ptylib "github.com/ryotarai/claude-code-wrapper-ui/internal/pty"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type message struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

type Handler struct {
	command string
}

func NewHandler(command string) *Handler {
	return &Handler{command: command}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade: %v", err)
		return
	}
	defer conn.Close()

	session, err := ptylib.NewSession(h.command, 120, 40)
	if err != nil {
		log.Printf("Start session: %v", err)
		conn.WriteJSON(message{Type: "error", Data: err.Error()})
		return
	}
	defer session.Close()

	// pty → WebSocket
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := session.Read(buf)
			if err != nil {
				conn.WriteJSON(message{Type: "exit"})
				return
			}
			msg := message{
				Type: "output",
				Data: base64.StdEncoding.EncodeToString(buf[:n]),
			}
			if err := conn.WriteJSON(msg); err != nil {
				return
			}
		}
	}()

	// WebSocket → pty
	for {
		var msg message
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}

		switch msg.Type {
		case "input":
			data, err := base64.StdEncoding.DecodeString(msg.Data)
			if err != nil {
				log.Printf("Decode input: %v", err)
				continue
			}
			if err := session.Write(data); err != nil {
				return
			}
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				session.Resize(uint16(msg.Cols), uint16(msg.Rows))
			}
		}
	}
}

// MarshalJSON helper — not needed externally, json tags handle it
var _ = json.Marshal
```

- [ ] **Step 5: Run test**

Run: `go test ./internal/ws/ -v -count=1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/ws/
git commit -m "Add WebSocket handler bridging browser to pty session"
```

---

### Task 3: Go Backend — HTTP Server Entry Point

**Files:**
- Create: `cmd/server/main.go`

- [ ] **Step 1: Create the server**

```go
// cmd/server/main.go
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/ryotarai/claude-code-wrapper-ui/internal/ws"
)

func main() {
	port := flag.Int("port", 8080, "HTTP port")
	command := flag.String("command", "claude", "Command to run in pty")
	staticDir := flag.String("static", "frontend/dist", "Static files directory")
	flag.Parse()

	handler := ws.NewHandler(*command)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handler.ServeHTTP)
	mux.Handle("/", http.FileServer(http.Dir(*staticDir)))

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Listening on %s", addr)

	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Fatal(err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down")
}
```

- [ ] **Step 2: Verify it builds**

Run: `go build -o server ./cmd/server/`
Expected: Binary `server` created with no errors

- [ ] **Step 3: Commit**

```bash
git add cmd/server/
git commit -m "Add HTTP server entry point serving WebSocket and static files"
```

---

### Task 4: Frontend — Project Scaffold (Vite + React + Tailwind)

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/index.html`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tailwind.config.ts`
- Create: `frontend/postcss.config.js`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/types.ts`
- Create: `frontend/src/index.css`

- [ ] **Step 1: Scaffold Vite project**

Run:
```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui
npm create vite@latest frontend -- --template react-ts
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
cd frontend
npm install
npm install -D tailwindcss @tailwindcss/vite
npm install @xterm/xterm @xterm/addon-fit
npm install react-markdown remark-gfm
```

- [ ] **Step 3: Configure Tailwind**

Replace `frontend/src/index.css`:
```css
@import "tailwindcss";
```

Update `frontend/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/ws': {
        target: 'http://localhost:8080',
        ws: true,
      },
    },
  },
})
```

- [ ] **Step 4: Create shared types**

```ts
// frontend/src/types.ts
export interface Span {
  text: string;
  fg: number | null;
  bg: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
}

export interface ScreenLine {
  lineNumber: number;
  text: string;
  spans: Span[];
}

export type BlockType =
  | "welcome"
  | "user-prompt"
  | "spinner"
  | "assistant-text"
  | "heading"
  | "bullet-list"
  | "code-block"
  | "tool-call"
  | "tool-result"
  | "diff"
  | "separator"
  | "input-prompt"
  | "status-bar"
  | "unknown";

export interface Block {
  type: BlockType;
  lines: ScreenLine[];
  /** Extracted plain text content for rendering components */
  content?: string;
  /** Additional metadata depending on block type */
  meta?: Record<string, unknown>;
}
```

- [ ] **Step 5: Create minimal App**

```tsx
// frontend/src/App.tsx
import { useState } from 'react'

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
      <p className="text-gray-400">Connecting to Claude Code...</p>
    </div>
  )
}
```

- [ ] **Step 6: Verify dev server starts**

Run: `cd frontend && npm run dev`
Expected: Vite dev server starts on localhost:5173

- [ ] **Step 7: Commit**

```bash
git add frontend/
git commit -m "Scaffold React frontend with Vite, Tailwind, xterm.js dependencies"
```

---

### Task 5: Frontend — WebSocket Hook

**Files:**
- Create: `frontend/src/hooks/useWebSocket.ts`

- [ ] **Step 1: Implement useWebSocket hook**

```ts
// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback, useState } from "react";

interface UseWebSocketOptions {
  url: string;
  onOutput: (data: Uint8Array) => void;
  onExit: () => void;
}

export function useWebSocket({ url, onOutput, onExit }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        onOutput(bytes);
      } else if (msg.type === "exit") {
        onExit();
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [url]);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "input",
        data: btoa(data),
      }));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "resize",
        cols,
        rows,
      }));
    }
  }, []);

  return { connected, sendInput, sendResize };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/
git commit -m "Add useWebSocket hook for pty communication"
```

---

### Task 6: Frontend — Hidden Terminal + Buffer Reader

**Files:**
- Create: `frontend/src/terminal/HiddenTerminal.ts`
- Create: `frontend/src/terminal/BufferReader.ts`
- Create: `frontend/tests/BufferReader.test.ts`

- [ ] **Step 1: Install test dependencies**

Run: `cd frontend && npm install -D vitest`

Add to `frontend/package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Write BufferReader test**

```ts
// frontend/tests/BufferReader.test.ts
import { describe, it, expect } from "vitest";
import { extractLines } from "../src/terminal/BufferReader";
import type { ScreenLine } from "../src/types";

// Manually constructed mock buffer matching hello_final.json structure
// We test the extraction logic with a simplified mock
describe("extractLines", () => {
  it("extracts spans with correct attributes from a mock buffer", () => {
    // Create a mock IBufferLine-like interface
    const mockLine = {
      length: 5,
      getCell: (x: number) => {
        if (x === 0) return mockCell("●", 231, null, false, false, false, false);
        if (x === 1) return mockCell(" ", null, null, false, false, false, false);
        if (x === 2) return mockCell("H", null, null, false, false, false, false);
        if (x === 3) return mockCell("i", null, null, false, false, false, false);
        if (x === 4) return mockCell("!", null, null, false, false, false, false);
        return null;
      },
    };

    const lines = extractLines({
      length: 1,
      getLine: (y: number) => (y === 0 ? mockLine : null),
    } as any);

    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("● Hi!");
    expect(lines[0].spans[0]).toMatchObject({
      text: "●",
      fg: 231,
    });
    expect(lines[0].spans[1]).toMatchObject({
      text: " Hi!",
      fg: null,
    });
  });
});

function mockCell(
  char: string,
  fg: number | null,
  bg: number | null,
  bold: boolean,
  italic: boolean,
  underline: boolean,
  dim: boolean,
) {
  return {
    getChars: () => char,
    getFgColor: () => fg ?? 0,
    getBgColor: () => bg ?? 0,
    isFgDefault: () => fg === null,
    isBgDefault: () => bg === null,
    isBold: () => bold ? 1 : 0,
    isItalic: () => italic ? 1 : 0,
    isUnderline: () => underline ? 1 : 0,
    isDim: () => dim ? 1 : 0,
  };
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/BufferReader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement HiddenTerminal**

```ts
// frontend/src/terminal/HiddenTerminal.ts
import { Terminal } from "@xterm/xterm";

const COLS = 120;
const ROWS = 40;

export class HiddenTerminal {
  readonly terminal: Terminal;
  private listeners: Array<() => void> = [];

  constructor() {
    this.terminal = new Terminal({
      cols: COLS,
      rows: ROWS,
      allowProposedApi: true,
      // Don't render — we only need the buffer
    });
  }

  mount(container: HTMLElement) {
    this.terminal.open(container);
  }

  write(data: Uint8Array) {
    this.terminal.write(data);
    this.notifyListeners();
  }

  onBufferChange(fn: () => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
  }

  dispose() {
    this.terminal.dispose();
  }

  private notifyListeners() {
    for (const fn of this.listeners) {
      fn();
    }
  }
}
```

- [ ] **Step 5: Implement BufferReader**

```ts
// frontend/src/terminal/BufferReader.ts
import type { ScreenLine, Span } from "../types";

interface BufferLike {
  length: number;
  getLine(y: number): LineLike | undefined | null;
}

interface LineLike {
  length: number;
  getCell(x: number): CellLike | undefined | null;
}

interface CellLike {
  getChars(): string;
  getFgColor(): number;
  getBgColor(): number;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isBold(): number;
  isItalic(): number;
  isUnderline(): number;
  isDim(): number;
}

export function extractLines(buffer: BufferLike): ScreenLine[] {
  const lines: ScreenLine[] = [];

  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;

    const spans: Span[] = [];
    let currentSpan: (Span & { _key: string }) | null = null;

    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;

      const char = cell.getChars();
      if (char === "" && x > 0) continue;

      const fg = cell.isFgDefault() ? null : cell.getFgColor();
      const bg = cell.isBgDefault() ? null : cell.getBgColor();
      const bold = !!cell.isBold();
      const italic = !!cell.isItalic();
      const underline = !!cell.isUnderline();
      const dim = !!cell.isDim();
      const key = `${fg}:${bg}:${bold}:${italic}:${underline}:${dim}`;

      if (currentSpan && currentSpan._key === key) {
        currentSpan.text += char;
      } else {
        if (currentSpan) {
          const { _key, ...span } = currentSpan;
          spans.push(span);
        }
        currentSpan = { text: char, fg, bg, bold, italic, underline, dim, _key: key };
      }
    }

    if (currentSpan) {
      const { _key, ...span } = currentSpan;
      spans.push(span);
    }

    const text = spans.map((s) => s.text).join("");
    lines.push({ lineNumber: y, text, spans });
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].text.trim() === "") {
    lines.pop();
  }

  return lines;
}
```

- [ ] **Step 6: Run test**

Run: `cd frontend && npx vitest run tests/BufferReader.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src/terminal/ frontend/tests/BufferReader.test.ts
git commit -m "Add HiddenTerminal wrapper and BufferReader with tests"
```

---

### Task 7: Frontend — Pattern Detector

**Files:**
- Create: `frontend/src/terminal/PatternDetector.ts`
- Create: `frontend/tests/PatternDetector.test.ts`

- [ ] **Step 1: Write PatternDetector tests using snapshot data**

```ts
// frontend/tests/PatternDetector.test.ts
import { describe, it, expect } from "vitest";
import { detectBlocks } from "../src/terminal/PatternDetector";
import helloFinal from "../../testdata/snapshots/hello_final.json";
import markdownFinal from "../../testdata/snapshots/markdown_final.json";
import diffFinal from "../../testdata/snapshots/diff_final.json";
import type { ScreenLine } from "../src/types";

describe("detectBlocks", () => {
  it("detects welcome box in hello scenario", () => {
    const blocks = detectBlocks(helloFinal.lines as ScreenLine[]);
    const welcome = blocks.find((b) => b.type === "welcome");
    expect(welcome).toBeDefined();
    expect(welcome!.lines.length).toBeGreaterThanOrEqual(10);
  });

  it("detects user prompt in hello scenario", () => {
    const blocks = detectBlocks(helloFinal.lines as ScreenLine[]);
    const prompts = blocks.filter((b) => b.type === "user-prompt");
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0].lines[0].text).toContain("say hello");
  });

  it("detects assistant response in hello scenario", () => {
    const blocks = detectBlocks(helloFinal.lines as ScreenLine[]);
    const responses = blocks.filter((b) => b.type === "assistant-text");
    expect(responses.length).toBeGreaterThanOrEqual(1);
  });

  it("detects headings in markdown scenario", () => {
    const blocks = detectBlocks(markdownFinal.lines as ScreenLine[]);
    const headings = blocks.filter((b) => b.type === "heading");
    expect(headings.length).toBeGreaterThanOrEqual(3);
  });

  it("detects code block in markdown scenario", () => {
    const blocks = detectBlocks(markdownFinal.lines as ScreenLine[]);
    const codeBlocks = blocks.filter((b) => b.type === "code-block");
    expect(codeBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it("detects tool call in diff scenario", () => {
    const blocks = detectBlocks(diffFinal.lines as ScreenLine[]);
    const toolCalls = blocks.filter((b) => b.type === "tool-call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("detects diff lines in diff scenario", () => {
    const blocks = detectBlocks(diffFinal.lines as ScreenLine[]);
    const diffs = blocks.filter((b) => b.type === "diff");
    expect(diffs.length).toBeGreaterThanOrEqual(1);
  });

  it("detects tool result in diff scenario", () => {
    const blocks = detectBlocks(diffFinal.lines as ScreenLine[]);
    const results = blocks.filter((b) => b.type === "tool-result");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("detects separator lines", () => {
    const blocks = detectBlocks(helloFinal.lines as ScreenLine[]);
    const seps = blocks.filter((b) => b.type === "separator");
    expect(seps.length).toBeGreaterThanOrEqual(1);
  });
});
```

Add to `frontend/vite.config.ts` (or create `vitest.config.ts`):
```ts
// Add to vite.config.ts
export default defineConfig({
  // ...existing config
  test: {
    globals: true,
  },
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/PatternDetector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PatternDetector**

```ts
// frontend/src/terminal/PatternDetector.ts
import type { ScreenLine, Block, Span } from "../types";

export function detectBlocks(lines: ScreenLine[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const text = line.text.trim();

    // Skip empty lines
    if (text === "") {
      i++;
      continue;
    }

    // Welcome box: starts with ╭ in fg 174
    if (text.startsWith("╭") && hasFg(line, 174)) {
      const start = i;
      while (i < lines.length && !lines[i].text.trim().startsWith("╰")) {
        i++;
      }
      if (i < lines.length) i++; // include ╰ line
      blocks.push({ type: "welcome", lines: lines.slice(start, i) });
      continue;
    }

    // Separator: all ─ characters in fg 244
    if (/^─+$/.test(text) && hasFg(line, 244)) {
      blocks.push({ type: "separator", lines: [line] });
      i++;
      continue;
    }

    // User prompt: ❯ with bg 237
    if (text.startsWith("❯") && hasBg(line, 237)) {
      blocks.push({
        type: "user-prompt",
        lines: [line],
        content: extractPromptText(line),
      });
      i++;
      continue;
    }

    // Tool call (completed): ● in fg 114 (green)
    if (text.startsWith("●") && hasSpanFg(line.spans[0], 114)) {
      const toolLines = [line];
      i++;
      // Collect ⎿ result lines + diff lines following
      while (i < lines.length) {
        const nextText = lines[i].text.trim();
        if (nextText.startsWith("⎿")) {
          toolLines.push(lines[i]);
          i++;
          continue;
        }
        // Diff lines have specific bg colors or dim line numbers
        if (isDiffLine(lines[i])) {
          // Collect all consecutive diff lines into a diff block first
          break;
        }
        break;
      }
      blocks.push({
        type: "tool-call",
        lines: toolLines,
        meta: extractToolMeta(line),
      });

      // Check for tool result (⎿ lines)
      if (toolLines.length > 1) {
        blocks.push({
          type: "tool-result",
          lines: toolLines.slice(1),
        });
      }

      // Collect diff lines
      if (i < lines.length && isDiffLine(lines[i])) {
        const diffStart = i;
        while (i < lines.length && isDiffLine(lines[i])) {
          i++;
        }
        blocks.push({ type: "diff", lines: lines.slice(diffStart, i) });
      }
      continue;
    }

    // Assistant response: ● in fg 231 (white)
    if (text.startsWith("●") && hasSpanFg(line.spans[0], 231)) {
      const start = i;
      i++;
      // Collect following content lines until next ● or ❯ or separator
      while (i < lines.length) {
        const next = lines[i].text.trim();
        if (next === "") { i++; continue; }
        if (next.startsWith("●")) break;
        if (next.startsWith("❯")) break;
        if (/^─+$/.test(next) && hasFg(lines[i], 244)) break;
        if (next.startsWith("╭")) break;
        if (next.startsWith("Resume this session")) break;
        i++;
      }
      const contentLines = lines.slice(start, i);

      // Sub-detect headings, bullets, code blocks within assistant response
      const subBlocks = detectAssistantContent(contentLines);
      blocks.push(...subBlocks);
      continue;
    }

    // Status bar: contains ⏵⏵
    if (text.includes("⏵⏵")) {
      blocks.push({ type: "status-bar", lines: [line] });
      i++;
      continue;
    }

    // Input prompt: ❯ without bg (waiting for input)
    if (text.startsWith("❯") && !hasBg(line, 237)) {
      blocks.push({ type: "input-prompt", lines: [line] });
      i++;
      continue;
    }

    // File read indicator: "Read N file"
    if (hasSpanFg(line.spans[0], 246) && text.startsWith("Read")) {
      blocks.push({ type: "tool-result", lines: [line] });
      i++;
      continue;
    }

    // Unknown
    blocks.push({ type: "unknown", lines: [line] });
    i++;
  }

  return blocks;
}

function detectAssistantContent(lines: ScreenLine[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const text = line.text.trim();

    if (text === "") { i++; continue; }

    // First line with ● marker — check if heading follows on same line
    if (text.startsWith("●") && i === 0) {
      // Check for heading: bold+italic+underline
      const afterMarker = line.spans.slice(1);
      if (afterMarker.some(s => s.bold && s.italic && s.underline && s.text.trim())) {
        blocks.push({
          type: "heading",
          lines: [line],
          content: afterMarker.map(s => s.text).join("").trim(),
          meta: { level: 1 },
        });
        i++;
        continue;
      }
      // Otherwise it's just response text
      blocks.push({
        type: "assistant-text",
        lines: [line],
        content: afterMarker.map(s => s.text).join("").trim(),
      });
      i++;
      continue;
    }

    // Heading: bold text at start of line (not a bullet)
    if (line.spans[0]?.bold && !text.startsWith("-") && !text.startsWith("●")) {
      blocks.push({
        type: "heading",
        lines: [line],
        content: text,
        meta: { level: 2 },
      });
      i++;
      continue;
    }

    // Bullet list
    if (text.startsWith("- ") || text.startsWith("- ")) {
      const start = i;
      i++;
      // Collect continuation lines (indented, no bullet prefix, no heading)
      while (i < lines.length) {
        const next = lines[i].text.trim();
        if (next === "") { i++; continue; }
        if (next.startsWith("- ")) break;
        if (lines[i].spans[0]?.bold && !next.startsWith("-")) break;
        if (next.startsWith("●")) break;
        // Continuation of previous bullet (wrapped text)
        if (!next.startsWith("-") && !isCodeLine(lines[i])) {
          i++;
          continue;
        }
        break;
      }
      blocks.push({ type: "bullet-list", lines: lines.slice(start, i) });
      continue;
    }

    // Code block: lines with syntax highlight colors (fg 4, 3, 2 — low color numbers used by Claude Code for syntax)
    if (isCodeLine(line)) {
      const start = i;
      while (i < lines.length && (isCodeLine(lines[i]) || lines[i].text.trim() === "")) {
        i++;
      }
      // Trim trailing empty lines
      let end = i;
      while (end > start && lines[end - 1].text.trim() === "") end--;
      blocks.push({ type: "code-block", lines: lines.slice(start, end) });
      continue;
    }

    // Plain assistant text
    blocks.push({
      type: "assistant-text",
      lines: [line],
      content: text,
    });
    i++;
  }

  return blocks;
}

function isCodeLine(line: ScreenLine): boolean {
  // Code lines use low fg color numbers for syntax highlighting: 2 (green), 3 (yellow), 4 (blue)
  return line.spans.some(s =>
    s.fg !== null && (s.fg === 2 || s.fg === 3 || s.fg === 4) && s.text.trim() !== ""
  );
}

function isDiffLine(line: ScreenLine): boolean {
  // Diff lines have non-null bg (add/remove colors) and line number patterns
  return line.spans.some(s => s.bg !== null && s.bg !== 237 && s.bg !== 16 && s.text.trim() !== "");
}

function hasFg(line: ScreenLine, color: number): boolean {
  return line.spans.some(s => s.fg === color);
}

function hasBg(line: ScreenLine, color: number): boolean {
  return line.spans.some(s => s.bg === color);
}

function hasSpanFg(span: Span | undefined, color: number): boolean {
  return span?.fg === color;
}

function extractPromptText(line: ScreenLine): string {
  return line.spans
    .filter(s => s.fg === 231)
    .map(s => s.text)
    .join("")
    .trim();
}

function extractToolMeta(line: ScreenLine): Record<string, unknown> {
  const boldSpan = line.spans.find(s => s.bold && s.text.trim() !== "●");
  const toolName = boldSpan?.text.trim() ?? "";
  const restText = line.spans
    .filter(s => !s.bold && s.text.trim() !== "●")
    .map(s => s.text)
    .join("");
  const argsMatch = restText.match(/\((.+)\)/);
  return {
    tool: toolName,
    args: argsMatch?.[1] ?? "",
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run tests/PatternDetector.test.ts`
Expected: PASS (9 tests). If some fail, adjust detection logic to match actual snapshot data.

- [ ] **Step 5: Iterate on failing tests**

If any tests fail, read the specific snapshot data and adjust the detection logic. The patterns are derived from real Claude Code output, so minor adjustments may be needed.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/terminal/PatternDetector.ts frontend/tests/PatternDetector.test.ts
git commit -m "Add PatternDetector with tests against real Claude Code snapshots"
```

---

### Task 8: Frontend — TerminalFallback Component

**Files:**
- Create: `frontend/src/components/TerminalFallback.tsx`

- [ ] **Step 1: Implement TerminalFallback**

This is the critical fallback renderer. Every unrecognized block renders through this — it must handle all ANSI attributes correctly.

```tsx
// frontend/src/components/TerminalFallback.tsx
import type { ScreenLine, Span } from "../types";

// xterm-256color palette (first 16 colors)
const COLORS_16: Record<number, string> = {
  0: "#000", 1: "#c00", 2: "#0a0", 3: "#aa0", 4: "#55f",
  5: "#a0a", 6: "#0aa", 7: "#aaa", 8: "#555", 9: "#f55",
  10: "#5f5", 11: "#ff5", 12: "#55f", 13: "#f5f", 14: "#5ff", 15: "#fff",
};

function fgColor(fg: number): string {
  if (fg < 16) return COLORS_16[fg] ?? "#aaa";
  if (fg < 232) {
    // 216-color cube
    const n = fg - 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor((n % 36) / 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  // Grayscale
  const v = (fg - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

function spanStyle(span: Span): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (span.fg !== null) style.color = fgColor(span.fg);
  if (span.bg !== null) style.backgroundColor = fgColor(span.bg);
  if (span.bold) style.fontWeight = "bold";
  if (span.italic) style.fontStyle = "italic";
  if (span.underline) style.textDecoration = "underline";
  if (span.dim) style.opacity = 0.5;
  return style;
}

export function TerminalFallback({ lines }: { lines: ScreenLine[] }) {
  return (
    <pre className="font-mono text-sm leading-5 whitespace-pre">
      {lines.map((line) => (
        <div key={line.lineNumber}>
          {line.spans.map((span, i) => (
            <span key={i} style={spanStyle(span)}>
              {span.text}
            </span>
          ))}
        </div>
      ))}
    </pre>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/TerminalFallback.tsx
git commit -m "Add TerminalFallback component for ANSI-colored text rendering"
```

---

### Task 9: Frontend — Semantic UI Components

**Files:**
- Create: `frontend/src/components/WelcomeCard.tsx`
- Create: `frontend/src/components/UserMessage.tsx`
- Create: `frontend/src/components/AssistantMessage.tsx`
- Create: `frontend/src/components/CodeBlock.tsx`
- Create: `frontend/src/components/ToolCallCard.tsx`
- Create: `frontend/src/components/DiffView.tsx`
- Create: `frontend/src/components/SpinnerIndicator.tsx`
- Create: `frontend/src/components/StatusBar.tsx`
- Create: `frontend/src/components/InputArea.tsx`

- [ ] **Step 1: WelcomeCard**

```tsx
// frontend/src/components/WelcomeCard.tsx
import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

export function WelcomeCard({ block }: { block: Block }) {
  return (
    <div className="mx-auto max-w-3xl my-4 rounded-lg border border-pink-900/50 bg-gray-900/50 p-4">
      <TerminalFallback lines={block.lines} />
    </div>
  );
}
```

- [ ] **Step 2: UserMessage**

```tsx
// frontend/src/components/UserMessage.tsx
import type { Block } from "../types";

export function UserMessage({ block }: { block: Block }) {
  return (
    <div className="my-3 flex justify-end px-4">
      <div className="max-w-2xl rounded-2xl bg-blue-900/40 border border-blue-800/50 px-4 py-2 text-gray-100">
        {block.content ?? block.lines[0]?.text.replace(/^❯\s*/, "")}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: AssistantMessage**

```tsx
// frontend/src/components/AssistantMessage.tsx
import type { Block } from "../types";

export function AssistantMessage({ block }: { block: Block }) {
  return (
    <div className="my-1 px-4 text-gray-200 leading-relaxed">
      {block.content ?? block.lines.map(l => l.text).join(" ")}
    </div>
  );
}
```

- [ ] **Step 4: CodeBlock**

```tsx
// frontend/src/components/CodeBlock.tsx
import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

export function CodeBlock({ block }: { block: Block }) {
  return (
    <div className="my-3 mx-4 rounded-lg border border-gray-700 bg-gray-900 overflow-x-auto">
      <div className="p-4">
        <TerminalFallback lines={block.lines} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: ToolCallCard**

```tsx
// frontend/src/components/ToolCallCard.tsx
import { useState } from "react";
import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

export function ToolCallCard({ block }: { block: Block }) {
  const [expanded, setExpanded] = useState(true);
  const tool = (block.meta?.tool as string) ?? "Tool";
  const args = (block.meta?.args as string) ?? "";

  return (
    <div className="my-2 mx-4 rounded-lg border border-gray-700 bg-gray-900/70">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-800/50"
      >
        <span className="text-green-400">●</span>
        <span className="font-bold text-gray-200">{tool}</span>
        <span className="text-gray-500">({args})</span>
        <span className="ml-auto text-gray-600">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && block.lines.length > 1 && (
        <div className="border-t border-gray-800 px-3 py-2">
          <TerminalFallback lines={block.lines.slice(1)} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: DiffView**

```tsx
// frontend/src/components/DiffView.tsx
import type { Block } from "../types";

export function DiffView({ block }: { block: Block }) {
  return (
    <div className="my-1 mx-4 rounded border border-gray-700 overflow-x-auto font-mono text-sm">
      {block.lines.map((line) => {
        const text = line.text.trim();
        // Detect add/remove from bg colors in spans
        const isAdd = line.spans.some(s => s.bg !== null && s.bg !== 237 && s.bg !== 16 && text.includes("+"));
        const isRemove = line.spans.some(s => s.bg !== null && s.bg !== 237 && s.bg !== 16 && text.includes("-"));

        let bg = "bg-transparent";
        if (isAdd) bg = "bg-green-950/50";
        if (isRemove) bg = "bg-red-950/50";

        return (
          <div key={line.lineNumber} className={`px-3 py-0.5 ${bg}`}>
            {line.spans.map((span, i) => (
              <span
                key={i}
                className={isAdd ? "text-green-300" : isRemove ? "text-red-300" : "text-gray-300"}
              >
                {span.text}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 7: SpinnerIndicator**

```tsx
// frontend/src/components/SpinnerIndicator.tsx
import type { Block } from "../types";

export function SpinnerIndicator({ block }: { block: Block }) {
  const text = block.lines[0]?.spans
    .filter(s => s.fg === 216 || s.fg === 174)
    .map(s => s.text)
    .join("") ?? "Thinking…";

  return (
    <div className="my-2 px-4 flex items-center gap-2 text-pink-300">
      <span className="animate-spin inline-block w-4 h-4 border-2 border-pink-400 border-t-transparent rounded-full" />
      <span className="text-sm">{text}</span>
    </div>
  );
}
```

- [ ] **Step 8: StatusBar**

```tsx
// frontend/src/components/StatusBar.tsx
import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

export function StatusBar({ block }: { block: Block }) {
  return (
    <div className="px-4 py-1 text-xs text-gray-500">
      <TerminalFallback lines={block.lines} />
    </div>
  );
}
```

- [ ] **Step 9: InputArea**

```tsx
// frontend/src/components/InputArea.tsx
interface InputAreaProps {
  onKeyData: (data: string) => void;
}

export function InputArea({ onKeyData }: InputAreaProps) {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 p-3"
      tabIndex={0}
      onKeyDown={(e) => {
        e.preventDefault();
        const data = keyEventToData(e);
        if (data) onKeyData(data);
      }}
    >
      <div className="text-gray-400 text-sm text-center">
        Type here — keystrokes are forwarded to Claude Code
      </div>
    </div>
  );
}

function keyEventToData(e: React.KeyboardEvent): string | null {
  // Special keys
  if (e.key === "Enter") return "\r";
  if (e.key === "Backspace") return "\x7f";
  if (e.key === "Tab") return "\t";
  if (e.key === "Escape") return "\x1b";
  if (e.key === "ArrowUp") return "\x1b[A";
  if (e.key === "ArrowDown") return "\x1b[B";
  if (e.key === "ArrowRight") return "\x1b[C";
  if (e.key === "ArrowLeft") return "\x1b[D";

  // Ctrl+key
  if (e.ctrlKey && e.key.length === 1) {
    const code = e.key.toLowerCase().charCodeAt(0) - 96;
    if (code > 0 && code < 27) return String.fromCharCode(code);
    return null;
  }

  // Regular character
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return e.key;
  }

  return null;
}
```

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/
git commit -m "Add semantic UI components: messages, code blocks, diffs, tools, spinner"
```

---

### Task 10: Frontend — Wire Everything Together in App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Implement App with all layers connected**

```tsx
// frontend/src/App.tsx
import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { HiddenTerminal } from "./terminal/HiddenTerminal";
import { extractLines } from "./terminal/BufferReader";
import { detectBlocks } from "./terminal/PatternDetector";
import type { Block } from "./types";

import { WelcomeCard } from "./components/WelcomeCard";
import { UserMessage } from "./components/UserMessage";
import { AssistantMessage } from "./components/AssistantMessage";
import { CodeBlock } from "./components/CodeBlock";
import { ToolCallCard } from "./components/ToolCallCard";
import { DiffView } from "./components/DiffView";
import { SpinnerIndicator } from "./components/SpinnerIndicator";
import { StatusBar } from "./components/StatusBar";
import { TerminalFallback } from "./components/TerminalFallback";
import { InputArea } from "./components/InputArea";

const WS_URL = `ws://${window.location.host}/ws`;

export default function App() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [exited, setExited] = useState(false);
  const hiddenTermRef = useRef<HiddenTerminal | null>(null);
  const hiddenDivRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hiddenDivRef.current && !hiddenTermRef.current) {
      const ht = new HiddenTerminal();
      ht.mount(hiddenDivRef.current);
      hiddenTermRef.current = ht;
    }
    return () => {
      hiddenTermRef.current?.dispose();
      hiddenTermRef.current = null;
    };
  }, []);

  const updateBlocks = useCallback(() => {
    const ht = hiddenTermRef.current;
    if (!ht) return;
    const lines = extractLines(ht.terminal.buffer.active as any);
    const detected = detectBlocks(lines);
    setBlocks(detected);
  }, []);

  const { connected, sendInput } = useWebSocket({
    url: WS_URL,
    onOutput: (data) => {
      hiddenTermRef.current?.write(data);
      // Debounce the block update
      requestAnimationFrame(updateBlocks);
    },
    onExit: () => setExited(true),
  });

  // Auto-scroll on block changes
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks]);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Hidden xterm.js container */}
      <div ref={hiddenDivRef} className="absolute -left-[9999px] w-0 h-0 overflow-hidden" />

      {/* Connection status */}
      {!connected && !exited && (
        <div className="p-4 text-center text-yellow-400">Connecting...</div>
      )}
      {exited && (
        <div className="p-4 text-center text-red-400">
          Session ended.{" "}
          <button
            onClick={() => window.location.reload()}
            className="underline hover:text-red-300"
          >
            Restart
          </button>
        </div>
      )}

      {/* Main content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto pb-16">
        {blocks.map((block, i) => (
          <BlockRenderer key={`${block.type}-${i}`} block={block} />
        ))}
      </div>

      {/* Input area */}
      <InputArea onKeyData={sendInput} />
    </div>
  );
}

function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case "welcome":
      return <WelcomeCard block={block} />;
    case "user-prompt":
      return <UserMessage block={block} />;
    case "assistant-text":
      return <AssistantMessage block={block} />;
    case "heading":
      return <Heading block={block} />;
    case "bullet-list":
      return <BulletList block={block} />;
    case "code-block":
      return <CodeBlock block={block} />;
    case "tool-call":
      return <ToolCallCard block={block} />;
    case "tool-result":
      return null; // rendered inside ToolCallCard
    case "diff":
      return <DiffView block={block} />;
    case "spinner":
      return <SpinnerIndicator block={block} />;
    case "separator":
      return <div className="my-2 border-t border-gray-800" />;
    case "status-bar":
      return <StatusBar block={block} />;
    case "input-prompt":
      return null; // handled by InputArea
    default:
      return <TerminalFallback lines={block.lines} />;
  }
}

function Heading({ block }: { block: Block }) {
  const level = (block.meta?.level as number) ?? 2;
  const text = block.content ?? block.lines[0]?.text ?? "";
  if (level === 1) {
    return <h2 className="text-xl font-bold text-gray-100 mt-4 mb-2 px-4">{text}</h2>;
  }
  return <h3 className="text-lg font-semibold text-gray-200 mt-3 mb-1 px-4">{text}</h3>;
}

function BulletList({ block }: { block: Block }) {
  // Group lines into bullet items
  const items: string[] = [];
  let current = "";
  for (const line of block.lines) {
    const text = line.text.trim();
    if (text === "") continue;
    if (text.startsWith("- ")) {
      if (current) items.push(current);
      current = text.slice(2);
    } else {
      current += " " + text;
    }
  }
  if (current) items.push(current);

  return (
    <ul className="my-1 px-4 list-disc list-inside space-y-1 text-gray-200">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Verify frontend builds**

Run: `cd frontend && npm run build`
Expected: Build succeeds, output in `frontend/dist/`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "Wire all layers together: WebSocket → xterm.js → PatternDetector → React"
```

---

### Task 11: Integration — Build & Run Full Stack

**Files:**
- Modify: `cmd/server/main.go` (no changes needed if correct)

- [ ] **Step 1: Build frontend**

Run: `cd frontend && npm run build`

- [ ] **Step 2: Build Go server**

Run: `cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui && go build -o server ./cmd/server/`

- [ ] **Step 3: Run the full stack**

Run: `./server -port 8080 -static frontend/dist`

Open `http://localhost:8080` in a browser. Claude Code should start in the pty and output should render in the browser with rich formatting.

- [ ] **Step 4: Verify key interactions work**

1. Type a message and press Enter — should send to Claude Code
2. Observe response rendering — headings, bullet lists, code blocks should render as styled components
3. If Claude Code asks for permission (y/n), typing `y` + Enter should work
4. Ctrl+C should send interrupt

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "Integration fixes from full-stack testing"
```

---

### Task 12: Dev Experience — Add Makefile

**Files:**
- Create: `Makefile`

- [ ] **Step 1: Create Makefile**

```makefile
# Makefile
.PHONY: dev build test clean

# Run frontend dev server + Go server concurrently
dev:
	@echo "Starting Go server on :8080..."
	@go run ./cmd/server/ -command claude &
	@echo "Starting Vite dev server..."
	@cd frontend && npm run dev

build: frontend-build
	go build -o server ./cmd/server/

frontend-build:
	cd frontend && npm run build

test: test-go test-frontend

test-go:
	go test ./... -v -count=1

test-frontend:
	cd frontend && npx vitest run

clean:
	rm -f server capture
	rm -rf frontend/dist
```

- [ ] **Step 2: Verify**

Run: `make test`
Expected: All Go and frontend tests pass

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "Add Makefile for dev, build, and test workflows"
```
