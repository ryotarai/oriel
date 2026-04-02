package conversation

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// MessageOrigin indicates where a JSONL entry originated.
type MessageOrigin struct {
	Kind string `json:"kind"`
}

// Message represents a parsed JSONL entry from Claude Code's conversation log.
type Message struct {
	Type      string          `json:"type"`
	UUID      string          `json:"uuid"`
	SessionID string          `json:"sessionId"`
	Timestamp string          `json:"timestamp"`
	CWD       string          `json:"cwd"`
	Message   json.RawMessage `json:"message"`
	IsMeta    bool            `json:"isMeta,omitempty"`
	Origin    *MessageOrigin  `json:"origin,omitempty"`
}

// ContentBlock represents a content block within a message.
type ContentBlock struct {
	Type     string          `json:"type"`
	Text     string          `json:"text,omitempty"`
	Thinking string          `json:"thinking,omitempty"`
	ID       string          `json:"id,omitempty"`
	Name     string          `json:"name,omitempty"`
	Input    json.RawMessage `json:"input,omitempty"`
	// tool_result fields
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
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
	CWD        string `json:"cwd,omitempty"`
	Text       string `json:"text"`
	Timestamp  string `json:"timestamp,omitempty"`
	IsThinking bool   `json:"isThinking,omitempty"`
	// Tool use fields
	ToolName  string `json:"toolName,omitempty"`
	ToolInput string `json:"toolInput,omitempty"`
	ToolUseID string `json:"toolUseId,omitempty"`
	// Tool result fields
	IsError bool `json:"isError,omitempty"`
	// Image fields (for tool_result image content)
	ImageData      string `json:"imageData,omitempty"`
	ImageMediaType string `json:"imageMediaType,omitempty"`
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

// ReadSessionEntries reads all conversation entries from a specific session's JSONL file.
func ReadSessionEntries(cwd, sessionID string) []ConversationEntry {
	projDir := projectDir(cwd)
	jsonlPath := filepath.Join(projDir, sessionID+".jsonl")
	return readAllEntries(jsonlPath)
}

// SessionHasContent checks whether a session's JSONL conversation file exists
// and contains at least one entry. Used to validate --resume targets.
func SessionHasContent(cwd, sessionID string) bool {
	projDir := projectDir(cwd)
	jsonlPath := filepath.Join(projDir, sessionID+".jsonl")
	info, err := os.Stat(jsonlPath)
	if err != nil || info.Size() == 0 {
		return false
	}
	return true
}

// WatchSession discovers the session JSONL from the child PID, reads existing
// entries, then tails for new ones. Runs until done is closed.
// If onSessionID is non-nil, it is called with the discovered Claude session UUID.
// If resumeSessionID is non-empty, the JSONL for that session is watched instead
// of the discovered one (Claude --resume writes to the original session's file).
func WatchSession(childPID int, ch chan<- ConversationEntry, done <-chan struct{}, onSessionID func(string), resumeSessionID string) {
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
		if onSessionID != nil {
			onSessionID(sessionID)
		}
		break
	}

	// When resuming, watch the original session's JSONL file because Claude
	// --resume writes new entries there, not to the newly created session file.
	watchID := sessionID
	if resumeSessionID != "" {
		watchID = resumeSessionID
	}
	jsonlPath := filepath.Join(projDir, watchID+".jsonl")
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
		entries = append(entries, parseLine(line)...)
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

		for _, entry := range parseLine(line) {
			select {
			case ch <- entry:
			case <-done:
				return
			}
		}
	}
}

func parseLine(line []byte) []ConversationEntry {
	var msg Message
	if err := json.Unmarshal(line, &msg); err != nil {
		return nil
	}

	if msg.Type != "user" && msg.Type != "assistant" {
		return nil
	}
	if msg.IsMeta {
		return nil
	}
	if msg.Origin != nil && msg.Origin.Kind == "task-notification" {
		return parseTaskNotification(msg)
	}

	var parsed ParsedMessage
	if err := json.Unmarshal(msg.Message, &parsed); err != nil {
		return nil
	}

	return extractEntries(parsed.Content, msg)
}

func extractEntries(content json.RawMessage, msg Message) []ConversationEntry {
	// Try string content (simple user messages)
	var str string
	if err := json.Unmarshal(content, &str); err == nil {
		if str == "" {
			return nil
		}
		return []ConversationEntry{{
			Type:      msg.Type,
			Role:      msg.Type,
			UUID:      msg.UUID,
			CWD:       msg.CWD,
			Text:      str,
			Timestamp: msg.Timestamp,
		}}
	}

	// Parse as array of content blocks
	var rawBlocks []json.RawMessage
	if err := json.Unmarshal(content, &rawBlocks); err != nil {
		return nil
	}

	var entries []ConversationEntry
	blockIdx := 0
	for _, raw := range rawBlocks {
		var block ContentBlock
		if err := json.Unmarshal(raw, &block); err != nil {
			continue
		}

		uuid := fmt.Sprintf("%s-%d", msg.UUID, blockIdx)
		blockIdx++

		switch block.Type {
		case "text":
			if block.Text == "" {
				continue
			}
			entries = append(entries, ConversationEntry{
				Type:      msg.Type,
				Role:      msg.Type,
				UUID:      uuid,
				CWD:       msg.CWD,
				Text:      block.Text,
				Timestamp: msg.Timestamp,
			})
		case "thinking":
			text := block.Thinking
			if text == "" {
				text = block.Text
			}
			if text == "" {
				continue
			}
			entries = append(entries, ConversationEntry{
				Type:       msg.Type,
				Role:       msg.Type,
				UUID:       uuid,
				CWD:        msg.CWD,
				Text:       text,
				Timestamp:  msg.Timestamp,
				IsThinking: true,
			})
		case "tool_use":
			inputStr := ""
			if block.Input != nil {
				inputStr = string(block.Input)
			}
			entries = append(entries, ConversationEntry{
				Type:      "tool_use",
				Role:      msg.Type,
				UUID:      uuid,
				CWD:       msg.CWD,
				Timestamp: msg.Timestamp,
				ToolName:  block.Name,
				ToolInput: inputStr,
				ToolUseID: block.ID,
			})
		case "tool_result":
			type imageSource struct {
				Type      string `json:"type"`
				MediaType string `json:"media_type"`
				Data      string `json:"data"`
			}
			type contentSubBlock struct {
				Type   string       `json:"type"`
				Text   string       `json:"text,omitempty"`
				Source *imageSource `json:"source,omitempty"`
			}

			var subBlocks []contentSubBlock
			parsed := false
			if block.Content != nil {
				if err := json.Unmarshal(block.Content, &subBlocks); err == nil {
					parsed = true
					var textParts []string
					for _, sb := range subBlocks {
						if sb.Type == "text" && sb.Text != "" {
							textParts = append(textParts, sb.Text)
						}
						if sb.Type == "image" && sb.Source != nil {
							imgUUID := fmt.Sprintf("%s-img-%d", msg.UUID, blockIdx)
							blockIdx++
							entries = append(entries, ConversationEntry{
								Type:           "tool_result",
								Role:           msg.Type,
								UUID:           imgUUID,
								CWD:            msg.CWD,
								Timestamp:      msg.Timestamp,
								ToolUseID:      block.ToolUseID,
								ImageData:      sb.Source.Data,
								ImageMediaType: sb.Source.MediaType,
							})
						}
					}
					if len(textParts) > 0 {
						entries = append(entries, ConversationEntry{
							Type:      "tool_result",
							Role:      msg.Type,
							UUID:      uuid,
							CWD:       msg.CWD,
							Timestamp: msg.Timestamp,
							Text:      strings.Join(textParts, "\n"),
							ToolUseID: block.ToolUseID,
							IsError:   block.IsError,
						})
					}
				}
			}
			if !parsed {
				text := extractToolResultText(block.Content)
				entries = append(entries, ConversationEntry{
					Type:      "tool_result",
					Role:      msg.Type,
					UUID:      uuid,
					CWD:       msg.CWD,
					Timestamp: msg.Timestamp,
					Text:      text,
					ToolUseID: block.ToolUseID,
					IsError:   block.IsError,
				})
			}
		}
	}
	return entries
}

var (
	taskStatusRe  = regexp.MustCompile(`<status>(.*?)</status>`)
	taskSummaryRe = regexp.MustCompile(`<summary>(.*?)</summary>`)
	taskResultRe  = regexp.MustCompile(`(?s)<result>(.*?)</result>`)
)

func parseTaskNotification(msg Message) []ConversationEntry {
	var parsed ParsedMessage
	if err := json.Unmarshal(msg.Message, &parsed); err != nil {
		return nil
	}

	// Content is a string containing XML
	var content string
	if err := json.Unmarshal(parsed.Content, &content); err != nil {
		return nil
	}

	statusMatch := taskStatusRe.FindStringSubmatch(content)
	if len(statusMatch) < 2 || statusMatch[1] != "completed" {
		return nil
	}

	summaryMatch := taskSummaryRe.FindStringSubmatch(content)
	resultMatch := taskResultRe.FindStringSubmatch(content)

	var text string
	if len(summaryMatch) >= 2 {
		text = "**" + summaryMatch[1] + "**\n\n"
	}
	if len(resultMatch) >= 2 {
		text += strings.TrimSpace(resultMatch[1])
	}
	if text == "" {
		return nil
	}

	return []ConversationEntry{{
		Type:      "assistant",
		Role:      "assistant",
		UUID:      msg.UUID,
		Timestamp: msg.Timestamp,
		Text:      text,
	}}
}

func extractToolResultText(content json.RawMessage) string {
	if content == nil {
		return ""
	}

	// Try string
	var str string
	if err := json.Unmarshal(content, &str); err == nil {
		return str
	}

	// Try array of sub-blocks
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text,omitempty"`
	}
	if err := json.Unmarshal(content, &blocks); err == nil {
		var parts []string
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}

	return ""
}
