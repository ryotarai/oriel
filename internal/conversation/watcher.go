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

// WatchSession discovers the session JSONL from the child PID, reads existing
// entries, then tails for new ones. Runs until done is closed.
func WatchSession(childPID int, ch chan<- ConversationEntry, done <-chan struct{}) {
	log.Printf("Discovering session for PID %d...", childPID)

	var projDir, sessionID string
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
		projDir = projectDir(meta.CWD)
		sessionID = meta.SessionID
		log.Printf("Session: %s (project: %s)", sessionID, projDir)
		break
	}

	jsonlPath := filepath.Join(projDir, sessionID+".jsonl")
	log.Printf("Watching JSONL: %s", jsonlPath)

	// Wait for file to appear
	for {
		if _, err := os.Stat(jsonlPath); err == nil {
			break
		}
		select {
		case <-done:
			return
		case <-time.After(500 * time.Millisecond):
		}
	}

	// Read existing entries
	if entries := readAllEntries(jsonlPath); len(entries) > 0 {
		for _, entry := range entries {
			select {
			case ch <- entry:
			case <-done:
				return
			}
		}
	}

	// Tail for new entries
	var offset int64
	if info, err := os.Stat(jsonlPath); err == nil {
		offset = info.Size()
	}
	tailJSONL(jsonlPath, offset, ch, done)
}

func readAllEntries(jsonlPath string) []ConversationEntry {
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
		if entry, ok := parseLine(line); ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

func tailJSONL(jsonlPath string, offset int64, ch chan<- ConversationEntry, done <-chan struct{}) {
	f, err := os.Open(jsonlPath)
	if err != nil {
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

		if entry, ok := parseLine(line); ok {
			select {
			case ch <- entry:
			case <-done:
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
