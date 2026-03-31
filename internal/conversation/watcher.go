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

// projectDir returns the Claude Code projects directory for a given cwd.
func projectDir(cwd string) string {
	home, _ := os.UserHomeDir()
	escaped := strings.NewReplacer("/", "-", ".", "-").Replace(cwd)
	return filepath.Join(home, ".claude", "projects", escaped)
}

// sessionsDir returns the Claude Code sessions directory.
func sessionsDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "sessions")
}

// discoverSessionID polls ~/.claude/sessions/ for a file matching the given PID
// and returns the sessionID and cwd.
func discoverSessionID(pid int, done <-chan struct{}) (sessionID, cwd string, err error) {
	target := fmt.Sprintf("%d.json", pid)
	path := filepath.Join(sessionsDir(), target)

	for {
		select {
		case <-done:
			return "", "", fmt.Errorf("cancelled")
		default:
		}

		data, err := os.ReadFile(path)
		if err != nil {
			// Claude Code hasn't written the session file yet; wait
			time.Sleep(500 * time.Millisecond)
			continue
		}

		var meta sessionMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			return "", "", fmt.Errorf("parse session meta: %w", err)
		}

		return meta.SessionID, meta.CWD, nil
	}
}

// WatchJSONL watches a JSONL file and sends new conversation entries to the channel.
func WatchJSONL(jsonlPath string, ch chan<- ConversationEntry, done <-chan struct{}) error {
	// Wait for file to appear
	for {
		if _, err := os.Stat(jsonlPath); err == nil {
			break
		}
		select {
		case <-done:
			return nil
		case <-time.After(500 * time.Millisecond):
		}
	}

	f, err := os.Open(jsonlPath)
	if err != nil {
		return fmt.Errorf("open jsonl: %w", err)
	}
	defer f.Close()

	reader := bufio.NewReader(f)

	for {
		select {
		case <-done:
			return nil
		default:
		}

		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				time.Sleep(200 * time.Millisecond)
				continue
			}
			return fmt.Errorf("read line: %w", err)
		}

		entry, ok := parseLine(line)
		if ok {
			select {
			case ch <- entry:
			case <-done:
				return nil
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

// WatchSession discovers the session ID from the child PID, then watches
// the corresponding JSONL file for conversation entries.
func WatchSession(childPID int, ch chan<- ConversationEntry, done <-chan struct{}) {
	log.Printf("Discovering session for PID %d...", childPID)

	sessionID, cwd, err := discoverSessionID(childPID, done)
	if err != nil {
		log.Printf("Failed to discover session: %v", err)
		return
	}

	log.Printf("Session discovered: %s (cwd: %s)", sessionID, cwd)

	projDir := projectDir(cwd)
	jsonlPath := filepath.Join(projDir, sessionID+".jsonl")

	log.Printf("Watching JSONL: %s", jsonlPath)
	if err := WatchJSONL(jsonlPath, ch, done); err != nil {
		log.Printf("JSONL watch error: %v", err)
	}
}
