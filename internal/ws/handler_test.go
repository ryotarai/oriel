package ws_test

import (
	"encoding/base64"
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
