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

// readLastSessionID reads the last sessionId from a JSONL file by scanning for
// the last line that contains a sessionId field.
func readLastSessionID(jsonlPath string) string {
	f, err := os.Open(jsonlPath)
	if err != nil {
		return ""
	}
	defer f.Close()

	var lastSessionID string
	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		// Quick extract of sessionId without full parse
		var partial struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(line, &partial) == nil && partial.SessionID != "" {
			lastSessionID = partial.SessionID
		}
	}
	return lastSessionID
}

// tailJSONL watches a JSONL file starting from a byte offset and sends new entries.
// It also monitors for sessionId changes within the file (caused by /clear or /resume).
// Returns the new sessionId if it changed, or "" if stopped by done/stopCh.
func tailJSONL(jsonlPath string, expectedSessionID string, offset int64, ch chan<- ConversationEntry, done <-chan struct{}, stopCh <-chan struct{}) string {
	f, err := os.Open(jsonlPath)
	if err != nil {
		log.Printf("tailJSONL open error: %v", err)
		return ""
	}
	defer f.Close()

	if offset > 0 {
		f.Seek(offset, io.SeekStart)
	}

	reader := bufio.NewReader(f)
	for {
		select {
		case <-done:
			return ""
		case <-stopCh:
			return ""
		default:
		}

		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				time.Sleep(200 * time.Millisecond)
				continue
			}
			return ""
		}

		// Check if sessionId changed (happens when /clear or /resume writes to the same PID's JSONL)
		var partial struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(line, &partial) == nil && partial.SessionID != "" && partial.SessionID != expectedSessionID {
			return partial.SessionID
		}

		entry, ok := parseLine(line)
		if ok {
			select {
			case ch <- entry:
			case <-done:
				return ""
			case <-stopCh:
				return ""
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

// WatchSession uses the child PID to find the initial sessionId and project directory,
// then watches the corresponding JSONL file. If the sessionId changes within the file
// (/clear, /resume), it sends a reset and switches to the new session's JSONL.
func WatchSession(childPID int, ch chan<- ConversationEntry, done <-chan struct{}) {
	log.Printf("Discovering session for PID %d...", childPID)

	// Discover project directory from session metadata
	var projDir string
	var initialSessionID string
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
		initialSessionID = meta.SessionID
		log.Printf("Initial session: %s (project: %s)", initialSessionID, projDir)
		break
	}

	currentSessionID := initialSessionID
	for {
		select {
		case <-done:
			return
		default:
		}

		jsonlPath := filepath.Join(projDir, currentSessionID+".jsonl")
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

		// Read and send existing entries
		existing := ReadAllEntries(jsonlPath)
		for _, entry := range existing {
			select {
			case ch <- entry:
			case <-done:
				return
			}
		}

		// Tail for new entries; returns new sessionId if it changes
		var offset int64
		if info, err := os.Stat(jsonlPath); err == nil {
			offset = info.Size()
		}

		stopTail := make(chan struct{})
		newSessionID := tailJSONL(jsonlPath, currentSessionID, offset, ch, done, stopTail)

		if newSessionID == "" {
			// Stopped by done channel
			return
		}

		// Session changed — reset frontend and switch
		log.Printf("Session changed: %s -> %s", currentSessionID, newSessionID)
		currentSessionID = newSessionID

		select {
		case ch <- ConversationEntry{Type: "reset"}:
		case <-done:
			return
		}
	}
}
