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

// Handler manages a single persistent pty session and allows
// WebSocket clients to attach/detach (e.g. on page reload).
type Handler struct {
	command string

	mu      sync.Mutex
	session *ptylib.Session
	// subscribers receive pty output and conversation entries
	subs map[*subscriber]struct{}
	// convHistory stores all conversation entries so reconnecting clients get them
	convHistory []conversation.ConversationEntry
	started     bool
	exited      bool
}

type subscriber struct {
	conn  *websocket.Conn
	wsMu  sync.Mutex
	doneCh chan struct{}
}

func (s *subscriber) writeJSON(msg message) error {
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	return s.conn.WriteJSON(msg)
}

func NewHandler(command string) *Handler {
	return &Handler{
		command: command,
		subs:    make(map[*subscriber]struct{}),
	}
}

// ensureSession starts the pty session if not already running.
func (h *Handler) ensureSession() error {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.started {
		return nil
	}

	session, err := ptylib.NewSession(h.command, 120, 40)
	if err != nil {
		return err
	}
	h.session = session
	h.started = true

	// pty output → broadcast to all subscribers
	go h.readPtyLoop()

	// JSONL conversation watcher
	go h.watchConversation()

	return nil
}

func (h *Handler) readPtyLoop() {
	buf := make([]byte, 4096)
	for {
		n, err := h.session.Read(buf)
		if err != nil {
			h.broadcast(message{Type: "exit"})
			h.mu.Lock()
			h.exited = true
			h.mu.Unlock()
			return
		}
		msg := message{
			Type: "output",
			Data: base64.StdEncoding.EncodeToString(buf[:n]),
		}
		h.broadcast(msg)
	}
}

func (h *Handler) watchConversation() {
	convCh := make(chan conversation.ConversationEntry, 64)
	done := h.session.Done()
	go conversation.WatchSession(h.session.Pid(), convCh, done)

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
			// Store in history for reconnecting clients
			h.mu.Lock()
			h.convHistory = append(h.convHistory, entry)
			h.mu.Unlock()

			h.broadcast(message{Type: "conversation", Entry: entryJSON})
		case <-done:
			return
		}
	}
}

func (h *Handler) broadcast(msg message) {
	h.mu.Lock()
	subs := make([]*subscriber, 0, len(h.subs))
	for s := range h.subs {
		subs = append(subs, s)
	}
	h.mu.Unlock()

	for _, s := range subs {
		if err := s.writeJSON(msg); err != nil {
			// Client disconnected; will be cleaned up when ServeHTTP returns
		}
	}
}

func (h *Handler) addSub(s *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[s] = struct{}{}
}

func (h *Handler) removeSub(s *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, s)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade: %v", err)
		return
	}
	defer conn.Close()

	if err := h.ensureSession(); err != nil {
		log.Printf("Start session: %v", err)
		conn.WriteJSON(message{Type: "error", Data: err.Error()})
		return
	}

	sub := &subscriber{
		conn:   conn,
		doneCh: make(chan struct{}),
	}
	h.addSub(sub)
	defer func() {
		h.removeSub(sub)
		close(sub.doneCh)
	}()

	// Send conversation history to reconnecting client
	h.mu.Lock()
	history := make([]conversation.ConversationEntry, len(h.convHistory))
	copy(history, h.convHistory)
	exited := h.exited
	h.mu.Unlock()

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

	// WebSocket → pty (input from this client)
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
			if err := h.session.Write(data); err != nil {
				return
			}
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				h.session.Resize(uint16(msg.Cols), uint16(msg.Rows))
			}
		}
	}
}
