package fileexplorer

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type TreeNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"`
	IsDir    bool        `json:"isDir"`
	Children []*TreeNode `json:"children,omitempty"`
}

// HandleTree returns the directory tree as JSON rooted at the working directory.
func HandleTree(w http.ResponseWriter, r *http.Request) {
	root, err := os.Getwd()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	tree := buildTree(root, root, 4)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tree)
}

// HandleFile returns the contents of a file as JSON { "content": "..." }.
func HandleFile(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		http.Error(w, "missing path parameter", http.StatusBadRequest)
		return
	}

	root, err := os.Getwd()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	absPath := filepath.Join(root, filepath.Clean(relPath))
	// Prevent directory traversal
	if !strings.HasPrefix(absPath, root) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	data, err := os.ReadFile(absPath)
	if err != nil && os.IsNotExist(err) {
		// File not found — search subdirectories for a matching basename
		if found := findFileByName(root, filepath.Base(relPath)); found != "" {
			absPath = filepath.Join(root, found)
			relPath = found
			data, err = os.ReadFile(absPath)
		}
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	// Limit to 1MB
	if len(data) > 1<<20 {
		data = data[:1<<20]
	}

	// Detect binary files (check for null bytes in first 8KB)
	checkLen := len(data)
	if checkLen > 8192 {
		checkLen = 8192
	}
	isBinary := false
	for i := 0; i < checkLen; i++ {
		if data[i] == 0 {
			isBinary = true
			break
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if isBinary {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content":  "",
			"path":     relPath,
			"isBinary": true,
		})
	} else {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content":  string(data),
			"path":     relPath,
			"isBinary": false,
		})
	}
}

func buildTree(root, dir string, maxDepth int) *TreeNode {
	rel, _ := filepath.Rel(root, dir)
	if rel == "." {
		rel = ""
	}

	node := &TreeNode{
		Name:  filepath.Base(dir),
		Path:  rel,
		IsDir: true,
	}

	if maxDepth <= 0 {
		return node
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return node
	}

	// Sort: directories first, then files, alphabetically
	sort.Slice(entries, func(i, j int) bool {
		di, dj := entries[i].IsDir(), entries[j].IsDir()
		if di != dj {
			return di
		}
		return entries[i].Name() < entries[j].Name()
	})

	for _, e := range entries {
		name := e.Name()
		if shouldSkip(name, e.Type()) {
			continue
		}

		childPath := filepath.Join(dir, name)
		if e.IsDir() {
			child := buildTree(root, childPath, maxDepth-1)
			node.Children = append(node.Children, child)
		} else {
			childRel, _ := filepath.Rel(root, childPath)
			node.Children = append(node.Children, &TreeNode{
				Name: name,
				Path: childRel,
			})
		}
	}

	return node
}

// findFileByName walks the directory tree looking for a file with the given
// base name, skipping the same directories as buildTree. Returns the first
// match as a path relative to root, or "" if none found.
func findFileByName(root, name string) string {
	var result string
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if shouldSkip(d.Name(), d.Type()) {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() == name {
			rel, _ := filepath.Rel(root, path)
			result = rel
			return filepath.SkipAll
		}
		return nil
	})
	return result
}

func shouldSkip(name string, mode fs.FileMode) bool {
	if mode&fs.ModeSymlink != 0 {
		return true
	}
	skip := map[string]bool{
		".git":         true,
		"node_modules": true,
		".DS_Store":    true,
		"__pycache__":  true,
		".next":        true,
		"dist":         true,
		"vendor":       true,
	}
	return skip[name]
}
