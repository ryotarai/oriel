package ws

import (
	"encoding/base64"
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
