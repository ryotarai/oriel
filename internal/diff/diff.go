package diff

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// FileDiff represents a single file's diff data.
type FileDiff struct {
	Path   string  `json:"path"`
	Status string  `json:"status"` // "M", "A", "D"
	Diff   *string `json:"diff"`   // nil for binary files
}

// CaptureHead returns the current HEAD commit hash in the given directory.
// Returns empty string if the repo has no commits.
func CaptureHead(dir string) string {
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// ComputeDiff returns per-file diffs between startCommit and the current working tree.
// If startCommit is empty, returns diffs of all tracked + untracked files.
func ComputeDiff(dir, startCommit string) ([]FileDiff, error) {
	var files []FileDiff

	if startCommit == "" {
		// No commits at session start — treat everything as new
		return diffNoBase(dir)
	}

	// Get changed files: git diff --name-status <startCommit>
	nsCmd := exec.Command("git", "diff", "--name-status", startCommit)
	nsCmd.Dir = dir
	nsOut, err := nsCmd.Output()
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(nsOut)), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) < 2 {
			continue
		}
		status := string(parts[0][0]) // first char: M, A, D, R, etc.
		path := parts[1]
		if status == "R" {
			// Rename: "R100\told\tnew" — parts[1] is "old\tnew"
			rParts := strings.SplitN(path, "\t", 2)
			if len(rParts) == 2 {
				path = rParts[1]
			}
			status = "A"
		}
		seen[path] = true
		d := fileDiff(dir, startCommit, path)
		files = append(files, FileDiff{Path: path, Status: status, Diff: d})
	}

	// Untracked files
	utCmd := exec.Command("git", "ls-files", "--others", "--exclude-standard")
	utCmd.Dir = dir
	utOut, err := utCmd.Output()
	if err == nil {
		for _, path := range strings.Split(strings.TrimSpace(string(utOut)), "\n") {
			if path == "" || seen[path] {
				continue
			}
			content := readFileContent(dir, path)
			files = append(files, FileDiff{Path: path, Status: "A", Diff: content})
		}
	}

	return files, nil
}

func fileDiff(dir, startCommit, path string) *string {
	cmd := exec.Command("git", "diff", startCommit, "--", path)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	s := string(out)
	return &s
}

func readFileContent(dir, path string) *string {
	data, err := os.ReadFile(filepath.Join(dir, path))
	if err != nil {
		return nil
	}
	// Check if binary (contains null bytes in first 8KB)
	check := data
	if len(check) > 8192 {
		check = check[:8192]
	}
	for _, b := range check {
		if b == 0 {
			return nil // binary
		}
	}
	// Format as unified diff "all added"
	lines := strings.Split(string(data), "\n")
	var buf strings.Builder
	buf.WriteString(fmt.Sprintf("--- /dev/null\n+++ b/%s\n", path))
	buf.WriteString(fmt.Sprintf("@@ -0,0 +1,%d @@\n", len(lines)))
	for _, l := range lines {
		buf.WriteString("+" + l + "\n")
	}
	s := buf.String()
	return &s
}

func diffNoBase(dir string) ([]FileDiff, error) {
	// List all tracked files as added
	cmd := exec.Command("git", "ls-files")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var files []FileDiff
	for _, path := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if path == "" {
			continue
		}
		content := readFileContent(dir, path)
		files = append(files, FileDiff{Path: path, Status: "A", Diff: content})
	}
	return files, nil
}
