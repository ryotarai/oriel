package ws

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/ryotarai/oriel/internal/conversation"
	"github.com/ryotarai/oriel/internal/diff"
	ptylib "github.com/ryotarai/oriel/internal/pty"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var (
	// "claude --resume <uuid>" — output when session ends (/exit) or on /resume
	resumePattern = regexp.MustCompile(`claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`)
	// "(no content)" — output by /clear
	clearPattern = regexp.MustCompile(`\(no content\)`)
	// Strip ANSI escape sequences for pattern matching
	ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[>\[?][0-9;]*[a-zA-Z]`)
)

type message struct {
	Type  string          `json:"type"`
	Data  string          `json:"data,omitempty"`
	Cols  int             `json:"cols,omitempty"`
	Rows  int             `json:"rows,omitempty"`
	Entry json.RawMessage `json:"entry,omitempty"`
}

// session is a single persistent pty session.
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
	command  string
	mu       sync.Mutex
	sessions map[string]*session
}

func NewHandler(command string) *Handler {
	return &Handler{
		command:  command,
		sessions: make(map[string]*session),
	}
}

func (h *Handler) getOrCreateSession(id string) (*session, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if s, ok := h.sessions[id]; ok {
		return s, nil
	}

	s := &session{
		id:        id,
		subs:      make(map[*subscriber]struct{}),
		cols:      120,
		rows:      40,
		restartCh: make(chan restartRequest, 1),
	}
	h.sessions[id] = s

	if err := h.startProcess(s); err != nil {
		delete(h.sessions, id)
		return nil, err
	}

	// Restart loop: when readPtyLoop detects /clear or /resume, it sends a
	// restartRequest. This goroutine handles the restart.
	go h.restartLoop(s)

	return s, nil
}

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

func (h *Handler) restartLoop(s *session) {
	for req := range s.restartCh {
		log.Printf("Session %s: restarting (resume=%s)", s.id, req.resumeSessionID)

		// Close old process
		s.mu.Lock()
		oldPty := s.pty
		s.mu.Unlock()
		if oldPty != nil {
			oldPty.Close()
		}

		// Clear conversation history and notify frontend
		s.mu.Lock()
		s.convHistory = nil
		cwd := s.cwd
		s.mu.Unlock()
		h.broadcast(s, message{Type: "conversation_reset"})

		// If resuming, load the old session's conversation entries
		if req.resumeSessionID != "" {
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
		if req.resumeSessionID != "" {
			args = []string{"--resume", req.resumeSessionID}
		}
		if err := h.startProcess(s, args...); err != nil {
			log.Printf("Session %s: restart failed: %v", s.id, err)
			h.broadcast(s, message{Type: "error", Data: err.Error()})
			continue
		}

		log.Printf("Session %s: restarted successfully", s.id)
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
		h.broadcast(s, message{
			Type: "output",
			Data: base64.StdEncoding.EncodeToString(data),
		})

		// Check for session change patterns in pty output
		// "Resume this session with:\nclaude --resume <uuid>"
		// Strip ANSI escape sequences before pattern matching
		detectBuf.Write(data)
		text := ansiPattern.ReplaceAllString(detectBuf.String(), "")

		// Detect /clear: "(no content)" in output
		if clearPattern.MatchString(text) {
			log.Printf("Session %s: detected /clear", s.id)
			detectBuf.Reset()
			select {
			case s.restartCh <- restartRequest{}:
			default:
			}
			return
		}

		// Detect session end: "claude --resume <uuid>"
		if m := resumePattern.FindStringSubmatch(text); m != nil {
			oldSessionID := m[1]
			log.Printf("Session %s: detected session end (old session: %s)", s.id, oldSessionID)
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
	s.mu.Unlock()

	convCh := make(chan conversation.ConversationEntry, 64)
	go conversation.WatchSession(pid, convCh, done)

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
		case <-done:
			return
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

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade: %v", err)
		return
	}
	defer conn.Close()

	sessionID := r.URL.Query().Get("session")
	if sessionID == "" {
		sessionID = "default"
	}

	s, err := h.getOrCreateSession(sessionID)
	if err != nil {
		log.Printf("Start session %s: %v", sessionID, err)
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
	exited := s.exited
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.subs, sub)
		s.mu.Unlock()
		close(sub.doneCh)
	}()

	// Replay conversation history
	for _, entry := range history {
		entryJSON, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		sub.writeJSON(message{Type: "conversation", Entry: entryJSON})
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
				log.Printf("Decode input: %v", err)
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
				log.Printf("Session %s: resume requested for %s", s.id, sessionToResume)
				select {
				case s.restartCh <- restartRequest{resumeSessionID: sessionToResume}:
				default:
				}
			}
		}
	}
}
