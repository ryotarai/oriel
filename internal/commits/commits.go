package commits

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
)

type CommitSummary struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

type CommitDetail struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
	Diff    string `json:"diff"`
}

func HandleList(w http.ResponseWriter, r *http.Request) {
	cmd := exec.Command("git", "log", "--pretty=format:%H\t%s\t%an\t%ci", "-100")
	if cwd := r.URL.Query().Get("cwd"); cwd != "" {
		cmd.Dir = cwd
	}
	out, err := cmd.Output()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var commits []CommitSummary
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			continue
		}
		commits = append(commits, CommitSummary{
			Hash:    parts[0],
			Subject: parts[1],
			Author:  parts[2],
			Date:    parts[3],
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(commits)
}

func HandleShow(w http.ResponseWriter, r *http.Request) {
	hash := r.URL.Query().Get("hash")
	if hash == "" {
		http.Error(w, "missing hash", http.StatusBadRequest)
		return
	}

	// Validate hash (prevent injection)
	for _, c := range hash {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			http.Error(w, "invalid hash", http.StatusBadRequest)
			return
		}
	}

	cwd := r.URL.Query().Get("cwd")

	msgCmd := exec.Command("git", "log", "-1", "--pretty=format:%s\n---BODY---\n%b", hash)
	if cwd != "" {
		msgCmd.Dir = cwd
	}
	msgOut, err := msgCmd.Output()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	diffCmd := exec.Command("git", "diff-tree", "-p", "--no-commit-id", hash)
	if cwd != "" {
		diffCmd.Dir = cwd
	}
	diffOut, err := diffCmd.Output()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	msgStr := string(msgOut)
	parts := strings.SplitN(msgStr, "\n---BODY---\n", 2)
	subject := parts[0]
	body := ""
	if len(parts) > 1 {
		body = strings.TrimSpace(parts[1])
	}

	detail := CommitDetail{
		Hash:    hash,
		Subject: subject,
		Body:    body,
		Diff:    string(diffOut),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(detail)
}
