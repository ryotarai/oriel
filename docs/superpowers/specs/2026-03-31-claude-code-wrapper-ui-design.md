# Claude Code Wrapper UI — Design Spec

## Purpose

A web application that wraps Claude Code's interactive mode (pty) and displays it in a browser with rich rendering: markdown, syntax-highlighted code, colored diffs, and tool call results.

## Architecture

```
Claude Code ←→ pty ←→ Go backend ←→ WebSocket ←→ Browser
                                                    ├── xterm.js (base terminal, hidden)
                                                    └── React UI (rich overlay)
```

### Go Backend

- **Single binary** serving both the WebSocket endpoint and the React static files.
- Uses `github.com/creack/pty` to spawn `claude` in interactive mode.
- Uses `github.com/gorilla/websocket` for bidirectional communication.
- WebSocket message types:
  - `output` (server→client): raw pty bytes, base64-encoded.
  - `input` (client→server): keystrokes from the browser.
  - `resize` (client→server): terminal size changes.
- Single session — one Claude Code process at a time.
- Graceful shutdown: SIGINT/SIGTERM sends SIGHUP to child pty process.

### React Frontend (Vite + TypeScript)

#### Layer 1: xterm.js (hidden terminal)

- An xterm.js `Terminal` instance interprets all incoming pty bytes.
- This terminal is **rendered off-screen** (hidden div or zero-size). Its sole purpose is to maintain accurate terminal state (screen buffer, cursor, colors).
- Provides the "ground truth" of what Claude Code's screen looks like at any point.

#### Layer 2: Screen Buffer Reader

- Periodically (every 100-200ms) and on each write, reads the xterm.js buffer via `terminal.buffer.active`.
- Extracts lines with their text content and ANSI decoration attributes (foreground color, bold, italic, underline).
- Produces an intermediate representation: `ScreenLine[]` where each line has `Span[]` (text + style).

#### Layer 3: Pattern Detector

Analyses the `ScreenLine[]` to identify semantic blocks. Detection is based on the patterns observed in captured test data:

| Pattern | Detection Signal | Render As |
|---|---|---|
| **Welcome box** | Lines starting with `╭`, `│`, `╰` with pink fg (color 174) | Styled card component |
| **User prompt** | Line starting with `❯` followed by text (white on gray bg, color 231 on bg 237) | Chat bubble (user) |
| **Thinking spinner** | Symbols `✢*✶✻✽·` in color 174, text in color 216 ending with `…` | Spinner component |
| **Response marker** | `●` in color 231 (white) at line start | Marks beginning of assistant response |
| **Markdown heading** | Bold+italic+underline (`[1m[3m[4m`) text, or bold-only text after `●` | `<h1>`-`<h3>` |
| **Bullet list** | Lines starting with `- ` or `  - ` | `<ul><li>` |
| **Inline code** | Text in color 153 (light blue) | `<code>` |
| **Code block** | Consecutive lines using syntax-highlight colors (34=blue/keyword, 33=yellow/func, 31=red/string, 32=green/number) | Syntax-highlighted `<pre>` block |
| **Tool call header** | `●` in color 246 followed by bold tool name + parenthesized args | Tool call card header |
| **Tool result** | `●` in color 114 (green) + `⎿` indented lines | Tool result card |
| **Diff/file content** | Indented lines after tool result with line numbers (`[2m N [22m`) | Diff viewer with line numbers |
| **Status bar** | Lines with `⏵⏵`, `◐`, `────` pattern | Footer status component |
| **Input prompt** | `❯` + cursor (color 246) in lower area | Input area indicator |

#### Layer 4: React Rendering

- When pattern detection succeeds, render the detected blocks with custom React components.
- When detection fails or for unrecognized regions, fall back to rendering the raw xterm.js buffer line-by-line with ANSI colors preserved (styled `<span>` elements).
- Components:
  - `WelcomeCard` — startup banner
  - `UserMessage` — user input bubble
  - `AssistantMessage` — wraps detected markdown/text response
  - `MarkdownBlock` — renders detected markdown using `react-markdown` + `remark-gfm`
  - `CodeBlock` — syntax-highlighted code with `highlight.js` or `prism`
  - `ToolCallCard` — collapsible card showing tool name, args, and result
  - `DiffView` — side-by-side or inline diff with color coding
  - `SpinnerIndicator` — thinking animation
  - `StatusBar` — bottom bar showing mode, effort level
  - `TerminalFallback` — raw ANSI-colored text for unrecognized output
  - `InputArea` — shows current input prompt state, forwards keystrokes to WebSocket

#### Input Handling

- The visible UI captures keyboard events globally.
- All keystrokes are forwarded via WebSocket to the Go backend → pty stdin.
- Special keys (Ctrl+C, Tab, arrow keys, etc.) are mapped to their terminal escape sequences.
- The xterm.js hidden instance handles the echo/display logic through the normal pty output loop.

## Data Flow (detailed)

1. User types in browser → `keydown` event → WebSocket `input` message → Go backend → `ptmx.Write()`
2. Claude Code writes to pty → `ptmx.Read()` → Go backend → WebSocket `output` message → browser
3. Browser receives output → feeds to hidden xterm.js → buffer reader extracts screen state → pattern detector identifies blocks → React re-renders

## Technology Stack

| Component | Technology |
|---|---|
| Backend | Go 1.26, `creack/pty`, `gorilla/websocket` |
| Frontend | React 19, Vite, TypeScript |
| Terminal | xterm.js, @xterm/addon-fit |
| Markdown | react-markdown, remark-gfm |
| Syntax highlight | highlight.js (or Prism) |
| Diff rendering | Custom component using detected ANSI colors |
| Styling | Tailwind CSS |

## File Structure

```
claude-code-wrapper-ui/
├── cmd/
│   └── server/
│       └── main.go          # Entry point
├── internal/
│   ├── pty/
│   │   └── session.go       # pty lifecycle management
│   └── ws/
│       └── handler.go       # WebSocket handler
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── hooks/
│   │   │   └── useWebSocket.ts
│   │   ├── terminal/
│   │   │   ├── HiddenTerminal.tsx    # xterm.js instance
│   │   │   ├── BufferReader.ts       # Screen buffer extraction
│   │   │   └── PatternDetector.ts    # Semantic block detection
│   │   ├── components/
│   │   │   ├── WelcomeCard.tsx
│   │   │   ├── UserMessage.tsx
│   │   │   ├── AssistantMessage.tsx
│   │   │   ├── MarkdownBlock.tsx
│   │   │   ├── CodeBlock.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── DiffView.tsx
│   │   │   ├── SpinnerIndicator.tsx
│   │   │   ├── StatusBar.tsx
│   │   │   ├── TerminalFallback.tsx
│   │   │   └── InputArea.tsx
│   │   └── types.ts
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── tailwind.config.ts
├── testdata/
│   ├── scenarios.yaml
│   ├── hello.raw
│   ├── markdown.raw
│   └── diff.raw
├── cmd/capture/              # Test data capture tool
├── go.mod
└── go.sum
```

## Error Handling

- **WebSocket disconnect**: Show reconnection UI, attempt auto-reconnect with backoff.
- **Claude Code process exit**: Detect pty EOF, show "session ended" with restart button.
- **Pattern detection failure**: Fall back to `TerminalFallback` component — always safe.

## Testing Strategy

- **BufferReader**: Unit tests using captured `.raw` files fed into xterm.js in a headless/node environment.
- **PatternDetector**: Unit tests with known screen buffer snapshots → expected block detection results.
- **Go backend**: Integration test spawning a simple echo process instead of `claude`.
- **E2E**: Playwright test launching the full stack and verifying basic interaction.

## Out of Scope (v1)

- Multiple concurrent sessions
- Session persistence / history
- Authentication
- Custom themes
- Mobile layout optimization
