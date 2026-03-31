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
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

// ParsedMessage is the inner message with role and content.
type ParsedMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// ConversationEntry is what we send to the frontend.
type ConversationEntry struct {
	Type    string `json:"type"`    // "user" or "assistant"
	Role    string `json:"role"`    // "user" or "assistant"
	UUID    string `json:"uuid"`    // unique ID
	Text    string `json:"text"`    // extracted plain text / markdown
	IsThinking bool `json:"isThinking,omitempty"` // thinking block
}

// ProjectDir returns the Claude Code projects directory for a given cwd.
func ProjectDir(cwd string) string {
	home, _ := os.UserHomeDir()
	escaped := strings.NewReplacer("/", "-", ".", "-").Replace(cwd)
	return filepath.Join(home, ".claude", "projects", escaped)
}

// FindJSONL finds JSONL files in the project directory and returns the most recent.
func FindJSONL(projectDir string) (string, error) {
	entries, err := os.ReadDir(projectDir)
	if err != nil {
		return "", fmt.Errorf("read project dir: %w", err)
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
			newest = filepath.Join(projectDir, e.Name())
		}
	}
	if newest == "" {
		return "", fmt.Errorf("no JSONL files found in %s", projectDir)
	}
	return newest, nil
}

// WatchJSONL watches a JSONL file and sends new conversation entries to the channel.
// It starts by reading existing entries, then tails for new ones.
func WatchJSONL(jsonlPath string, ch chan<- ConversationEntry, done <-chan struct{}) error {
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
				// Wait for more data
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

	// Only process user and assistant messages
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
	// Content can be a string or array of content blocks
	var str string
	if err := json.Unmarshal(content, &str); err == nil {
		return str, false
	}

	var blocks []ContentBlock
	if err := json.Unmarshal(content, &blocks); err != nil {
		// Try as array of mixed types (tool_result etc.)
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

	for _, block := range blocks {
		if block.Type == "text" && block.Text != "" {
			return block.Text, false
		}
		if block.Type == "thinking" && block.Text != "" {
			return block.Text, true
		}
	}
	return "", false
}

// WatchForSession watches the project directory for a JSONL file matching the session.
// It polls until a file appears, then starts watching it.
func WatchForSession(cwd string, ch chan<- ConversationEntry, done <-chan struct{}) {
	projectDir := ProjectDir(cwd)

	for {
		select {
		case <-done:
			return
		default:
		}

		jsonlPath, err := FindJSONL(projectDir)
		if err != nil {
			log.Printf("Waiting for JSONL file in %s: %v", projectDir, err)
			time.Sleep(1 * time.Second)
			continue
		}

		log.Printf("Watching JSONL: %s", jsonlPath)
		if err := WatchJSONL(jsonlPath, ch, done); err != nil {
			log.Printf("JSONL watch error: %v", err)
		}
		return
	}
}
