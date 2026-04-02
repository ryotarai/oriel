package state

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type Tab struct {
	ID       string
	Name     string
	Position int
}

type Pane struct {
	ID               string
	TabID            string
	SessionID        string
	ClaudeSessionID  string
	Cwd              string
	WorktreeDir      string
	Position         int
}

type Store struct {
	db *sql.DB
}

// DefaultPath returns the default state database path: ~/.config/oriel/state.sqlite3
func DefaultPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "oriel", "state.sqlite3")
}

func Open(path string) (*Store, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open state db: %w", err)
	}

	// Enable WAL mode for better concurrent access
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set WAL mode: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate state db: %w", err)
	}

	// Set file permissions to 0600
	if err := os.Chmod(path, 0o600); err != nil {
		db.Close()
		return nil, fmt.Errorf("chmod state db: %w", err)
	}

	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS config (
			id          INTEGER PRIMARY KEY CHECK (id = 1),
			auth_token  TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS tabs (
			id        TEXT PRIMARY KEY,
			name      TEXT NOT NULL,
			position  INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS panes (
			id                TEXT PRIMARY KEY,
			tab_id            TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
			session_id        TEXT NOT NULL,
			claude_session_id TEXT NOT NULL DEFAULT '',
			cwd               TEXT NOT NULL,
			worktree_dir      TEXT NOT NULL DEFAULT '',
			position          INTEGER NOT NULL
		);
	`)
	if err != nil {
		return err
	}
	// Migration: add claude_session_id column if missing (existing DBs)
	s.db.Exec("ALTER TABLE panes ADD COLUMN claude_session_id TEXT NOT NULL DEFAULT ''")
	return nil
}

// ListTabs returns all tabs ordered by position.
func (s *Store) ListTabs() ([]Tab, error) {
	rows, err := s.db.Query("SELECT id, name, position FROM tabs ORDER BY position")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tabs []Tab
	for rows.Next() {
		var t Tab
		if err := rows.Scan(&t.ID, &t.Name, &t.Position); err != nil {
			return nil, err
		}
		tabs = append(tabs, t)
	}
	return tabs, rows.Err()
}

// ListPanes returns all panes for a tab ordered by position.
func (s *Store) ListPanes(tabID string) ([]Pane, error) {
	rows, err := s.db.Query("SELECT id, tab_id, session_id, claude_session_id, cwd, worktree_dir, position FROM panes WHERE tab_id = ? ORDER BY position", tabID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var panes []Pane
	for rows.Next() {
		var p Pane
		if err := rows.Scan(&p.ID, &p.TabID, &p.SessionID, &p.ClaudeSessionID, &p.Cwd, &p.WorktreeDir, &p.Position); err != nil {
			return nil, err
		}
		panes = append(panes, p)
	}
	return panes, rows.Err()
}

// SaveFullState replaces all tabs and panes in a single transaction.
func (s *Store) SaveFullState(tabs []Tab, panes []Pane) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec("DELETE FROM panes"); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM tabs"); err != nil {
		return err
	}

	for _, t := range tabs {
		if _, err := tx.Exec("INSERT INTO tabs (id, name, position) VALUES (?, ?, ?)", t.ID, t.Name, t.Position); err != nil {
			return err
		}
	}
	for _, p := range panes {
		if _, err := tx.Exec("INSERT INTO panes (id, tab_id, session_id, claude_session_id, cwd, worktree_dir, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
			p.ID, p.TabID, p.SessionID, p.ClaudeSessionID, p.Cwd, p.WorktreeDir, p.Position); err != nil {
			return err
		}
	}

	return tx.Commit()
}
