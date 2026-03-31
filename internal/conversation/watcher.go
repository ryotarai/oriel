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

// findNewestJSONL returns the most recently modified JSONL file in a directory.
func findNewestJSONL(dir string) (string, time.Time, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", time.Time{}, err
	}

	var newest string
	var newestTime time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newestTime) {
			newestTime = info.ModTime()
			newest = filepath.Join(dir, e.Name())
		}
	}
	if newest == "" {
		return "", time.Time{}, fmt.Errorf("no JSONL files found")
	}
	return newest, newestTime, nil
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
func TailJSONL(jsonlPath string, offset int64, ch chan<- ConversationEntry, done <-chan struct{}, stopCh <-chan struct{}) {
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

// WatchSession discovers the project directory from the child PID's session metadata,
// then continuously watches for the newest JSONL file in that directory.
// When a newer JSONL appears (/clear, /resume), it sends a reset, replays the new
// file's entries, and starts tailing it.
func WatchSession(childPID int, ch chan<- ConversationEntry, done <-chan struct{}) {
	log.Printf("Discovering session for PID %d...", childPID)

	// First, discover the project directory from session metadata
	var projDir string
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
		log.Printf("Project dir: %s", projDir)
		break
	}

	var currentJSONL string
	var stopTail chan struct{}

	for {
		select {
		case <-done:
			return
		default:
		}

		newest, _, err := findNewestJSONL(projDir)
		if err != nil {
			time.Sleep(1 * time.Second)
			continue
		}

		if newest == currentJSONL {
			time.Sleep(1 * time.Second)
			continue
		}

		// JSONL file changed — stop old tailer
		if stopTail != nil {
			close(stopTail)
		}

		currentJSONL = newest
		log.Printf("Watching JSONL: %s", currentJSONL)

		// Send reset to frontend
		select {
		case ch <- ConversationEntry{Type: "reset"}:
		case <-done:
			return
		}

		// Read and replay existing entries
		existing := ReadAllEntries(currentJSONL)
		for _, entry := range existing {
			select {
			case ch <- entry:
			case <-done:
				return
			}
		}

		// Get file size for tail offset
		var offset int64
		if info, err := os.Stat(currentJSONL); err == nil {
			offset = info.Size()
		}

		// Start tailing new entries
		stopTail = make(chan struct{})
		go TailJSONL(currentJSONL, offset, ch, done, stopTail)

		time.Sleep(1 * time.Second)
	}
}
