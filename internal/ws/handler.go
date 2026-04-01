package ws

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/ryotarai/claude-code-wrapper-ui/internal/conversation"
	ptylib "github.com/ryotarai/claude-code-wrapper-ui/internal/pty"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type message struct {
	Type  string          `json:"type"`
	Data  string          `json:"data,omitempty"`
	Cols  int             `json:"cols,omitempty"`
	Rows  int             `json:"rows,omitempty"`
	Entry json.RawMessage `json:"entry,omitempty"`
}

// session is a single persistent pty session.
type session struct {
	id      string
	pty     *ptylib.Session
	mu      sync.Mutex
	subs    map[*subscriber]struct{}
	convHistory []conversation.ConversationEntry
	exited  bool
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

	ptySess, err := ptylib.NewSession(h.command, 120, 40)
	if err != nil {
		return nil, err
	}

	s := &session{
		id:   id,
		pty:  ptySess,
		subs: make(map[*subscriber]struct{}),
	}
	h.sessions[id] = s

	// pty output → broadcast
	go h.readPtyLoop(s)
	// JSONL watcher
	go h.watchConversation(s)

	return s, nil
}

func (h *Handler) readPtyLoop(s *session) {
	buf := make([]byte, 4096)
	for {
		n, err := s.pty.Read(buf)
		if err != nil {
			h.broadcast(s, message{Type: "exit"})
			s.mu.Lock()
			s.exited = true
			s.mu.Unlock()
			return
		}
		msg := message{
			Type: "output",
			Data: base64.StdEncoding.EncodeToString(buf[:n]),
		}
		h.broadcast(s, msg)
	}
}

func (h *Handler) watchConversation(s *session) {
	convCh := make(chan conversation.ConversationEntry, 64)
	done := s.pty.Done()
	go conversation.WatchSession(s.pty.Pid(), convCh, done)

	for {
		select {
		case entry, ok := <-convCh:
			if !ok {
				return
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

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade: %v", err)
		return
	}
	defer conn.Close()

	// Session ID from query parameter, default to "default"
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

		switch msg.Type {
		case "input":
			data, err := base64.StdEncoding.DecodeString(msg.Data)
			if err != nil {
				log.Printf("Decode input: %v", err)
				continue
			}
			if err := s.pty.Write(data); err != nil {
				return
			}
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				s.pty.Resize(uint16(msg.Cols), uint16(msg.Rows))
			}
		}
	}
}
