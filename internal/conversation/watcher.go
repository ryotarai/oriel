package conversation

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Message represents a parsed JSONL entry from Claude Code's conversation log.
type Message struct {
	Type      string          `json:"type"`
	UUID      string          `json:"uuid"`
	SessionID string          `json:"sessionId"`
	Timestamp string          `json:"timestamp"`
	Message   json.RawMessage `json:"message"`
}

// ContentBlock represents a content block within a message.
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// ParsedMessage is the inner message with role and content.
type ParsedMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// ConversationEntry is what we send to the frontend.
type ConversationEntry struct {
	Type       string `json:"type"`
	Role       string `json:"role"`
	UUID       string `json:"uuid"`
	Text       string `json:"text"`
	IsThinking bool   `json:"isThinking,omitempty"`
}

// sessionMeta matches ~/.claude/sessions/<pid>.json
type sessionMeta struct {
	PID       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	CWD       string `json:"cwd"`
}

func projectDir(cwd string) string {
	home, _ := os.UserHomeDir()
	escaped := strings.NewReplacer("/", "-", ".", "-").Replace(cwd)
	return filepath.Join(home, ".claude", "projects", escaped)
}

func sessionsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "sessions")
}

func readSessionMeta(pid int) (*sessionMeta, error) {
	path := filepath.Join(sessionsDir(), fmt.Sprintf("%d.json", pid))
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var meta sessionMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

// ReadAllEntries reads all conversation entries from a JSONL file.
func ReadAllEntries(jsonlPath string) []ConversationEntry {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	var entries []ConversationEntry
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		entry, ok := parseLine(line)
		if ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

// TailJSONL watches a JSONL file starting from a byte offset and sends new entries.
// It returns when the done channel is closed or stopCh receives.
func TailJSONL(jsonlPath string, offset int64, ch chan<- ConversationEntry, done <-chan struct{}, stopCh <-chan struct{}) {
	// Wait for file to appear
	for {
		if _, err := os.Stat(jsonlPath); err == nil {
			break
		}
		select {
		case <-done:
			return
		case <-stopCh:
			return
		case <-time.After(500 * time.Millisecond):
		}
	}

	f, err := os.Open(jsonlPath)
	if err != nil {
		log.Printf("TailJSONL open error: %v", err)
		return
	}
	defer f.Close()

	if offset > 0 {
		f.Seek(offset, io.SeekStart)
	}

	reader := bufio.NewReader(f)
	for {
		select {
		case <-done:
			return
		case <-stopCh:
			return
		default:
		}

		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				time.Sleep(200 * time.Millisecond)
				continue
			}
			return
		}

		entry, ok := parseLine(line)
		if ok {
			select {
			case ch <- entry:
			case <-done:
				return
			case <-stopCh:
				return
			}
		}
	}
}

func parseLine(line []byte) (ConversationEntry, bool) {
	var msg Message
	if err := json.Unmarshal(line, &msg); err != nil {
		return ConversationEntry{}, false
	}

	if msg.Type != "user" && msg.Type != "assistant" {
		return ConversationEntry{}, false
	}

	var parsed ParsedMessage
	if err := json.Unmarshal(msg.Message, &parsed); err != nil {
		return ConversationEntry{}, false
	}

	text, isThinking := extractText(parsed.Content)
	if text == "" {
		return ConversationEntry{}, false
	}

	return ConversationEntry{
		Type:       msg.Type,
		Role:       parsed.Role,
		UUID:       msg.UUID,
		Text:       text,
		IsThinking: isThinking,
	}, true
}

func extractText(content json.RawMessage) (string, bool) {
	var str string
	if err := json.Unmarshal(content, &str); err == nil {
		return str, false
	}

	var rawBlocks []json.RawMessage
	if err := json.Unmarshal(content, &rawBlocks); err != nil {
		return "", false
	}
	for _, raw := range rawBlocks {
		var block ContentBlock
		if err := json.Unmarshal(raw, &block); err != nil {
			continue
		}
		if block.Type == "text" && block.Text != "" {
			return block.Text, false
		}
		if block.Type == "thinking" && block.Text != "" {
			return block.Text, true
		}
	}
	return "", false
}

// WatchSession continuously monitors the session metadata for the child PID.
// When the sessionId changes (/clear, /resume), it sends a reset sentinel,
// then replays the new JSONL's existing entries and tails for new ones.
//
// The reset sentinel has Type="reset" to tell the frontend to clear conversation state.
func WatchSession(childPID int, ch chan<- ConversationEntry, done <-chan struct{}) {
	log.Printf("Discovering session for PID %d...", childPID)

	var currentSessionID string
	var stopTail chan struct{}

	for {
		select {
		case <-done:
			return
		default:
		}

		meta, err := readSessionMeta(childPID)
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}

		if meta.SessionID == currentSessionID {
			time.Sleep(1 * time.Second)
			continue
		}

		// Session changed — stop old tailer
		if stopTail != nil {
			close(stopTail)
		}

		currentSessionID = meta.SessionID
		projDir := projectDir(meta.CWD)
		jsonlPath := filepath.Join(projDir, currentSessionID+".jsonl")

		log.Printf("Session switched to %s, watching %s", currentSessionID, jsonlPath)

		// Send reset to frontend
		select {
		case ch <- ConversationEntry{Type: "reset"}:
		case <-done:
			return
		}

		// Read and replay existing entries
		existing := ReadAllEntries(jsonlPath)
		for _, entry := range existing {
			select {
			case ch <- entry:
			case <-done:
				return
			}
		}

		// Get file size for tail offset
		var offset int64
		if info, err := os.Stat(jsonlPath); err == nil {
			offset = info.Size()
		}

		// Start tailing new entries
		stopTail = make(chan struct{})
		go TailJSONL(jsonlPath, offset, ch, done, stopTail)

		time.Sleep(1 * time.Second)
	}
}
