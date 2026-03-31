package conversation

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// SessionSummary is returned by the sessions API.
type SessionSummary struct {
	SessionID    string `json:"sessionId"`
	FirstMessage string `json:"firstMessage"`
	MessageCount int    `json:"messageCount"`
	LastActivity int64  `json:"lastActivity"` // unix millis
}

// historyEntry matches ~/.claude/history.jsonl
type historyEntry struct {
	Display   string `json:"display"`
	Timestamp int64  `json:"timestamp"`
	Project   string `json:"project"`
	SessionID string `json:"sessionId"`
}

// ListSessions reads ~/.claude/history.jsonl and returns session summaries
// filtered by project path.
func ListSessions(projectPath string) []SessionSummary {
	home, _ := os.UserHomeDir()
	historyPath := filepath.Join(home, ".claude", "history.jsonl")

	f, err := os.Open(historyPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	type sessionData struct {
		firstMsg  string
		count     int
		lastTS    int64
	}
	sessions := make(map[string]*sessionData)

	reader := bufio.NewReader(f)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		var entry historyEntry
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		if entry.Project != projectPath || entry.SessionID == "" {
			continue
		}

		sd, ok := sessions[entry.SessionID]
		if !ok {
			sd = &sessionData{firstMsg: entry.Display}
			sessions[entry.SessionID] = sd
		}
		sd.count++
		if entry.Timestamp > sd.lastTS {
			sd.lastTS = entry.Timestamp
		}
	}

	result := make([]SessionSummary, 0, len(sessions))
	for sid, sd := range sessions {
		// Skip sessions with only slash commands as first message
		if sd.firstMsg == "" {
			continue
		}
		result = append(result, SessionSummary{
			SessionID:    sid,
			FirstMessage: truncate(sd.firstMsg, 100),
			MessageCount: sd.count,
			LastActivity: sd.lastTS,
		})
	}

	// Sort by last activity, newest first
	sort.Slice(result, func(i, j int) bool {
		return result[i].LastActivity > result[j].LastActivity
	})

	return result
}

// ProjectPathForPID reads sessions/<pid>.json and returns the cwd.
func ProjectPathForPID(pid int) string {
	meta, err := readSessionMeta(pid)
	if err != nil {
		return ""
	}
	return meta.CWD
}

func truncate(s string, maxLen int) string {
	r := []rune(s)
	if len(r) <= maxLen {
		return s
	}
	return string(r[:maxLen]) + "…"
}

// FormatTimestamp formats a unix millis timestamp as a relative time string.
func FormatTimestamp(ts int64) string {
	t := time.UnixMilli(ts)
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return formatDuration(int(d.Minutes()), "minute")
	case d < 24*time.Hour:
		return formatDuration(int(d.Hours()), "hour")
	default:
		return formatDuration(int(d.Hours()/24), "day")
	}
}

func formatDuration(n int, unit string) string {
	if n == 1 {
		return "1 " + unit + " ago"
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10)) + " " + unit + "s ago"
}
