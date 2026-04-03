package ws

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/gorilla/websocket"
	"github.com/ryotarai/oriel/internal/conversation"
	"github.com/ryotarai/oriel/internal/diff"
	ptylib "github.com/ryotarai/oriel/internal/pty"
	"github.com/ryotarai/oriel/internal/state"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var (
	// Matches the /clear output: "⎿  (no content)" (includes non-breaking space \u00a0)
	clearPattern = regexp.MustCompile(`⎿[\s\x{00a0}]+\(no content\)`)
	// Strip ANSI escape sequences for pattern matching
	ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[>\[?][0-9;]*[a-zA-Z]`)
)

const appendSystemPrompt = `<critical_rules>
When creating or entering a git worktree, you MUST use the EnterWorktree tool. When leaving a git worktree, you MUST use the ExitWorktree tool. NEVER use raw "git worktree add" + "cd" commands manually. This is critical for the UI to track your working directory correctly.
</critical_rules>`

type message struct {
	Type  string          `json:"type"`
	Data  string          `json:"data,omitempty"`
	Cols  int             `json:"cols,omitempty"`
	Rows  int             `json:"rows,omitempty"`
	Entry json.RawMessage `json:"entry,omitempty"`
	Epoch uint64          `json:"epoch,omitempty"`
}

const ptyOutputBufSize = 256 * 1024 // 256 KiB ring buffer for PTY output replay

// session is a single persistent pty session.
type session struct {
	id  string
	pty *ptylib.Session

	mu          sync.Mutex
	subs        map[*subscriber]struct{}
	convHistory []conversation.ConversationEntry
	exited      bool

	// Ring buffer of raw PTY output for replaying to new subscribers
	ptyOutputBuf []byte

	// Current terminal size (for restart)
	cols, rows uint16

	// Working directory for diff/file operations
	cwd string

	// Worktree directory (set when Claude enters a git worktree); used for diff/files/commits
	worktreeDir string

	// Notifies file watcher when worktreeDir changes
	worktreeDirChanged chan string

	// The real Claude CLI session UUID (discovered from ~/.claude/sessions/<pid>.json)
	claudeSessionID string

	// The session ID being resumed (set when --resume is used); used to watch the
	// correct JSONL file because Claude writes to the original session's file, not
	// the newly created one.
	resumeSessionID string

	// Epoch counter: incremented on every restart to discard stale conversation
	// entries from old watchConversation goroutines that race with conversation_reset.
	convEpoch uint64

	// Signal channel: closed when the session needs to restart
	restartCh chan restartRequest
}

type restartRequest struct {
	resumeSessionID string // empty = fresh start, non-empty = --resume <id>
}

type subscriber struct {
	conn   *websocket.Conn
	wsMu   sync.Mutex
	doneCh chan struct{}
}

func (s *subscriber) writeJSON(msg message) error {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	return s.conn.WriteJSON(msg)
}

// Handler manages multiple pty sessions, each identified by an ID
// passed as a query parameter (?session=<id>).
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

func (h *Handler) getOrCreateSession(id string, cwd string, resumeID string) (*session, error) {
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
		restartCh:          make(chan restartRequest, 1),
		worktreeDirChanged: make(chan string, 1),
	}
	h.sessions[id] = s

	// If resuming a previous Claude session, pass --resume flag
	var args []string
	if resumeID != "" && conversation.SessionHasContent(cwd, resumeID) {
		s.resumeSessionID = resumeID
		args = []string{"--resume", resumeID}
		// Pre-load conversation history from the old session
		oldEntries := conversation.ReadSessionEntries(cwd, resumeID)
		if len(oldEntries) > 0 {
			s.convHistory = append(s.convHistory, oldEntries...)
		}
	}

	if err := h.startProcess(s, args...); err != nil {
		delete(h.sessions, id)
		return nil, err
	}

	// Restart loop: when readPtyLoop detects /clear or /resume, it sends a
	// restartRequest. This goroutine handles the restart.
	go h.restartLoop(s)

	return s, nil
}

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

func (h *Handler) restartLoop(s *session) {
	for req := range s.restartCh {
		slog.Debug("Session restarting", "session", s.id, "resume", req.resumeSessionID)

		// Close old process
		s.mu.Lock()
		oldPty := s.pty
		s.mu.Unlock()
		if oldPty != nil {
			oldPty.Close()
		}

		// Clear conversation history, PTY output buffer, and session ID; notify frontend
		s.mu.Lock()
		s.convEpoch++
		s.convHistory = nil
		s.ptyOutputBuf = nil
		s.claudeSessionID = ""
		s.resumeSessionID = ""
		cwd := s.cwd
		epoch := s.convEpoch
		s.mu.Unlock()
		h.broadcast(s, message{Type: "conversation_reset", Epoch: epoch})

		// If resuming, load the old session's conversation entries
		if req.resumeSessionID != "" && conversation.SessionHasContent(cwd, req.resumeSessionID) {
			s.mu.Lock()
			s.resumeSessionID = req.resumeSessionID
			s.mu.Unlock()
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
					h.broadcast(s, message{Type: "conversation", Entry: entryJSON, Epoch: epoch})
				}
			}
		}

		// Start new process
		var args []string
		if req.resumeSessionID != "" && conversation.SessionHasContent(cwd, req.resumeSessionID) {
			args = []string{"--resume", req.resumeSessionID}
		}
		if err := h.startProcess(s, args...); err != nil {
			slog.Error("Session restart failed", "session", s.id, "error", err)
			h.broadcast(s, message{Type: "error", Data: err.Error()})
			continue
		}

		slog.Debug("Session restarted successfully", "session", s.id)
	}
}

func (h *Handler) readPtyLoop(s *session) {
	buf := make([]byte, 4096)
	// Buffer for detecting patterns across read boundaries
	var detectBuf strings.Builder

	for {
		n, err := s.pty.Read(buf)
		if err != nil {
			h.broadcast(s, message{Type: "exit"})
			s.mu.Lock()
			s.exited = true
			s.mu.Unlock()
			return
		}

		data := buf[:n]

		// Buffer raw PTY output for replay to new subscribers
		s.mu.Lock()
		s.ptyOutputBuf = append(s.ptyOutputBuf, data...)
		if len(s.ptyOutputBuf) > ptyOutputBufSize {
			s.ptyOutputBuf = s.ptyOutputBuf[len(s.ptyOutputBuf)-ptyOutputBufSize:]
		}
		s.mu.Unlock()

		h.broadcast(s, message{
			Type: "output",
			Data: base64.StdEncoding.EncodeToString(data),
		})

		// Check for session change patterns in pty output
		// "Resume this session with:\nclaude --resume <uuid>"
		// Strip ANSI escape sequences before pattern matching
		detectBuf.Write(data)
		text := ansiPattern.ReplaceAllString(detectBuf.String(), "")

		// Detect /clear
		if clearPattern.MatchString(text) {
			slog.Debug("Detected /clear", "session", s.id, "detectBuf", text)
			detectBuf.Reset()
			select {
			case s.restartCh <- restartRequest{}:
			default:
			}
			return
		}


		// Keep buffer bounded — only need last ~200 bytes for pattern matching
		if detectBuf.Len() > 500 {
			recent := text[len(text)-200:]
			detectBuf.Reset()
			detectBuf.WriteString(recent)
		}
	}
}

func (h *Handler) watchConversation(s *session) {
	s.mu.Lock()
	pid := s.pty.Pid()
	done := s.pty.Done()
	resumeID := s.resumeSessionID
	epoch := s.convEpoch
	s.mu.Unlock()

	convCh := make(chan conversation.ConversationEntry, 64)
	go conversation.WatchSession(pid, convCh, done, func(uuid string) {
		slog.Debug("Discovered Claude session UUID", "session", s.id, "uuid", uuid)
		// For resumed sessions, use the original session ID because
		// conversation data lives in the original session's JSONL.
		effectiveID := uuid
		if resumeID != "" {
			effectiveID = resumeID
		}
		s.mu.Lock()
		s.claudeSessionID = effectiveID
		s.mu.Unlock()
		// Don't broadcast yet — wait until the session has conversation content
		// so that empty sessions don't get a claudeSessionId saved to DB.
	}, resumeID)

	uuidBroadcast := false
	// Track pending EnterWorktree tool call ID to detect the corresponding
	// cwd change in subsequent entries (the tool_result after EnterWorktree
	// will carry the new worktree path in its cwd field).
	var pendingEnterWorktreeToolID string

	for {
		select {
		case entry, ok := <-convCh:
			if !ok {
				return
			}

			// If the epoch has changed, this goroutine is stale — stop broadcasting.
			s.mu.Lock()
			if s.convEpoch != epoch {
				s.mu.Unlock()
				return
			}
			s.mu.Unlock()

			if entry.Type == "reset" {
				s.mu.Lock()
				s.convHistory = nil
				s.mu.Unlock()
				h.broadcast(s, message{Type: "conversation_reset"})
				continue
			}

			// Detect EnterWorktree/ExitWorktree tool calls
			if entry.Type == "tool_use" && entry.ToolName == "EnterWorktree" {
				slog.Debug("Detected EnterWorktree tool call", "session", s.id, "toolUseID", entry.ToolUseID)
				pendingEnterWorktreeToolID = entry.ToolUseID
			}
			if entry.Type == "tool_use" && entry.ToolName == "ExitWorktree" {
				slog.Debug("Detected ExitWorktree tool call", "session", s.id)
				s.mu.Lock()
				s.worktreeDir = ""
				s.mu.Unlock()
				h.broadcast(s, message{Type: "worktree_changed", Data: ""})
				// Notify file watcher to switch back to original cwd
				select {
				case s.worktreeDirChanged <- "":
				default:
				}
			}
			// After EnterWorktree, the tool_result carries the new cwd
			if pendingEnterWorktreeToolID != "" && entry.Type == "tool_result" && entry.ToolUseID == pendingEnterWorktreeToolID {
				if entry.CWD != "" {
					slog.Debug("Worktree entered", "session", s.id, "dir", entry.CWD)
					s.mu.Lock()
					s.worktreeDir = entry.CWD
					s.mu.Unlock()
					h.broadcast(s, message{Type: "worktree_changed", Data: entry.CWD})
					// Notify file watcher to switch to worktree directory
					select {
					case s.worktreeDirChanged <- entry.CWD:
					default:
					}
				}
				pendingEnterWorktreeToolID = ""
			}

			entryJSON, err := json.Marshal(entry)
			if err != nil {
				continue
			}
			s.mu.Lock()
			s.convHistory = append(s.convHistory, entry)
			s.mu.Unlock()
			h.broadcast(s, message{Type: "conversation", Entry: entryJSON, Epoch: epoch})

			// After first real conversation entry, broadcast the UUID to save to DB.
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

func (h *Handler) startFileWatcher(s *session, done <-chan struct{}) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		slog.Error("Failed to start file watcher", "session", s.id, "error", err)
		return
	}
	defer watcher.Close()

	s.mu.Lock()
	dir := s.worktreeDir
	if dir == "" {
		dir = s.cwd
	}
	s.mu.Unlock()

	if err := watcher.Add(dir); err != nil {
		slog.Warn("Failed to watch directory", "session", s.id, "dir", dir, "error", err)
		return
	}
	slog.Debug("Watching directory for file changes", "session", s.id, "dir", dir)

	var debounceTimer *time.Timer

	for {
		select {
		case <-done:
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			return
		case newDir := <-s.worktreeDirChanged:
			// Switch watched directory when worktree changes
			_ = watcher.Remove(dir)
			targetDir := newDir
			if targetDir == "" {
				targetDir = s.cwd
			}
			if err := watcher.Add(targetDir); err != nil {
				slog.Warn("Failed to watch directory", "session", s.id, "dir", targetDir, "error", err)
			} else {
				dir = targetDir
				slog.Debug("Switched file watcher directory", "session", s.id, "dir", dir)
			}
			// Trigger immediate refresh since directory changed
			h.broadcast(s, message{Type: "files_changed"})
		case ev, ok := <-watcher.Events:
			if !ok {
				return
			}
			// Only react to meaningful file operations (not Chmod)
			if !ev.Has(fsnotify.Create) && !ev.Has(fsnotify.Write) && !ev.Has(fsnotify.Remove) && !ev.Has(fsnotify.Rename) {
				continue
			}
			// Skip .git internal changes to avoid feedback loop with git commands
			if strings.HasPrefix(filepath.Base(ev.Name), ".git") {
				continue
			}
			// Debounce: reset timer on each event
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			debounceTimer = time.AfterFunc(1*time.Second, func() {
				h.broadcast(s, message{Type: "files_changed"})
			})
		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			slog.Warn("File watcher error", "session", s.id, "error", err)
		}
	}
}

func (h *Handler) broadcast(s *session, msg message) {
	s.mu.Lock()
	subs := make([]*subscriber, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.mu.Unlock()

	for _, sub := range subs {
		sub.writeJSON(msg)
	}
}

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

	// Notify frontend that suggestions are being generated
	h.broadcast(s, message{Type: "suggestions_loading"})

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

// HandleListSessions returns the session list for the current project as JSON.
func (h *Handler) HandleListSessions(w http.ResponseWriter, r *http.Request) {
	// Find project path from any active session
	h.mu.Lock()
	var projectPath string
	for _, s := range h.sessions {
		s.mu.Lock()
		if s.pty != nil {
			projectPath = conversation.ProjectPathForPID(s.pty.Pid())
		}
		s.mu.Unlock()
		if projectPath != "" {
			break
		}
	}
	h.mu.Unlock()

	if projectPath == "" {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
		return
	}

	sessions := conversation.ListSessions(projectPath)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sessions)
}

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

	// Prefer explicit cwd from query param (set by frontend from effectiveDir),
	// fall back to session state.
	dir := r.URL.Query().Get("cwd")
	if dir == "" {
		s.mu.Lock()
		dir = s.worktreeDir
		if dir == "" {
			dir = s.cwd
		}
		s.mu.Unlock()
	}

	files, err := diff.ComputeDiff(dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"files": files,
	})
}

// HandleSaveState saves the full tab/pane layout to the state database.
func (h *Handler) HandleSaveState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload struct {
		Tabs []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Position int    `json:"position"`
		} `json:"tabs"`
		Panes []struct {
			ID              string `json:"id"`
			TabID           string `json:"tabId"`
			SessionID       string `json:"sessionId"`
			ClaudeSessionID string `json:"claudeSessionId"`
			Cwd             string `json:"cwd"`
			WorktreeDir     string `json:"worktreeDir"`
			Position        int    `json:"position"`
		} `json:"panes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	tabs := make([]state.Tab, len(payload.Tabs))
	for i, t := range payload.Tabs {
		tabs[i] = state.Tab{ID: t.ID, Name: t.Name, Position: t.Position}
	}
	panes := make([]state.Pane, len(payload.Panes))
	for i, p := range payload.Panes {
		panes[i] = state.Pane{
			ID: p.ID, TabID: p.TabID, SessionID: p.SessionID,
			ClaudeSessionID: p.ClaudeSessionID,
			Cwd: p.Cwd, WorktreeDir: p.WorktreeDir, Position: p.Position,
		}
	}

	if err := h.store.SaveFullState(tabs, panes); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandleLoadState returns the saved tab/pane layout from the state database.
func (h *Handler) HandleLoadState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	tabs, err := h.store.ListTabs()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type paneJSON struct {
		ID              string `json:"id"`
		TabID           string `json:"tabId"`
		SessionID       string `json:"sessionId"`
		ClaudeSessionID string `json:"claudeSessionId"`
		Cwd             string `json:"cwd"`
		WorktreeDir     string `json:"worktreeDir"`
		Position        int    `json:"position"`
	}
	type tabJSON struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Position int    `json:"position"`
	}

	var respTabs []tabJSON
	var respPanes []paneJSON

	for _, t := range tabs {
		panes, err := h.store.ListPanes(t.ID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		var tabPanes []paneJSON
		for _, p := range panes {
			// Skip panes whose cwd no longer exists
			if p.Cwd != "" {
				if _, err := os.Stat(p.Cwd); os.IsNotExist(err) {
					slog.Debug("Skipping pane with non-existent cwd", "pane", p.ID, "cwd", p.Cwd)
					continue
				}
			}
			tabPanes = append(tabPanes, paneJSON{
				ID: p.ID, TabID: p.TabID, SessionID: p.SessionID,
				ClaudeSessionID: p.ClaudeSessionID,
				Cwd: p.Cwd, WorktreeDir: p.WorktreeDir, Position: p.Position,
			})
		}
		// Skip tabs with no remaining panes
		if len(tabPanes) == 0 {
			continue
		}
		respTabs = append(respTabs, tabJSON{ID: t.ID, Name: t.Name, Position: t.Position})
		respPanes = append(respPanes, tabPanes...)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"tabs":  respTabs,
		"panes": respPanes,
	})
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("WebSocket upgrade failed", "error", err)
		return
	}
	defer conn.Close()

	sessionID := r.URL.Query().Get("session")
	if sessionID == "" {
		sessionID = "default"
	}

	cwd := r.URL.Query().Get("cwd")
	resumeID := r.URL.Query().Get("resume")
	s, err := h.getOrCreateSession(sessionID, cwd, resumeID)
	if err != nil {
		slog.Error("Failed to start session", "session", sessionID, "error", err)
		conn.WriteJSON(message{Type: "error", Data: err.Error()})
		return
	}

	sub := &subscriber{
		conn:   conn,
		doneCh: make(chan struct{}),
	}

	s.mu.Lock()
	s.subs[sub] = struct{}{}
	history := make([]conversation.ConversationEntry, len(s.convHistory))
	copy(history, s.convHistory)
	// Snapshot buffered PTY output for replay
	var ptySnapshot []byte
	if len(s.ptyOutputBuf) > 0 {
		ptySnapshot = make([]byte, len(s.ptyOutputBuf))
		copy(ptySnapshot, s.ptyOutputBuf)
	}
	claudeSessID := s.claudeSessionID
	exited := s.exited
	epoch := s.convEpoch
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.subs, sub)
		s.mu.Unlock()
		close(sub.doneCh)
	}()

	// Replay buffered PTY output so the terminal is not blank on reconnect
	if len(ptySnapshot) > 0 {
		sub.writeJSON(message{
			Type: "output",
			Data: base64.StdEncoding.EncodeToString(ptySnapshot),
		})
	}

	// Replay conversation history
	for _, entry := range history {
		entryJSON, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		sub.writeJSON(message{Type: "conversation", Entry: entryJSON, Epoch: epoch})
	}

	// Replay discovered Claude session UUID so the frontend can update its state
	if claudeSessID != "" {
		sub.writeJSON(message{Type: "claude_session_id", Data: claudeSessID})
	}

	// Send resolved cwd to client
	s.mu.Lock()
	resolvedCwd := s.cwd
	s.mu.Unlock()
	if resolvedCwd != "" {
		sub.writeJSON(message{Type: "cwd", Data: resolvedCwd})
	}

	if exited {
		sub.writeJSON(message{Type: "exit"})
		return
	}

	// WebSocket → pty
	for {
		var msg message
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}

		s.mu.Lock()
		pty := s.pty
		s.mu.Unlock()

		switch msg.Type {
		case "input":
			data, err := base64.StdEncoding.DecodeString(msg.Data)
			if err != nil {
				slog.Warn("Failed to decode input", "error", err)
				continue
			}
			if err := pty.Write(data); err != nil {
				return
			}
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				s.mu.Lock()
				s.cols = uint16(msg.Cols)
				s.rows = uint16(msg.Rows)
				s.mu.Unlock()
				pty.Resize(uint16(msg.Cols), uint16(msg.Rows))
			}
		case "resume":
			// Resume a specific session by ID
			sessionToResume := msg.Data
			if sessionToResume != "" {
				slog.Debug("Resume requested", "session", s.id, "resumeSession", sessionToResume)
				select {
				case s.restartCh <- restartRequest{resumeSessionID: sessionToResume}:
				default:
				}
			}
		case "set_cwd":
			newCwd := msg.Data
			if newCwd != "" {
				if info, err := os.Stat(newCwd); err == nil && info.IsDir() {
					s.mu.Lock()
					s.cwd = newCwd
					s.claudeSessionID = ""
					s.mu.Unlock()
					slog.Debug("CWD changed", "session", s.id, "cwd", newCwd)
					select {
					case s.restartCh <- restartRequest{}:
					default:
					}
				}
			}
		}
	}
}
