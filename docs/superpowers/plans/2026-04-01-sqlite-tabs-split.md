# SQLite Persistence, Bottom Tabs, Draggable Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite-backed state persistence (auth token + pane/tab layout), a bottom tab bar for multiple pane groups, and draggable left-right split in Diff/Files/Commits panels.

**Architecture:** Go backend gains `internal/state` package using `modernc.org/sqlite` for `~/.config/oriel/state.sqlite3` (0600). Frontend `App.tsx` wraps existing pane management inside a tab model, with a bottom tab bar. Panel components get a shared resize handle for their left-right split.

**Tech Stack:** Go + modernc.org/sqlite, React 19, TypeScript, Tailwind CSS 4

---

## File Structure

### New Files
- `internal/state/state.go` — SQLite store: Open, Close, schema migrations, CRUD for config/tabs/panes
- `frontend/src/hooks/useResizableSplit.ts` — Shared hook for left-right drag resize
- `frontend/src/components/BottomTabBar.tsx` — Bottom tab bar component

### Modified Files
- `go.mod` — Add `modernc.org/sqlite` dependency
- `cmd/oriel/main.go` — Open state store, pass to auth, pass to ws.Handler, close on shutdown
- `internal/auth/auth.go` — `LoadOrGenerateToken(store)` replaces `GenerateToken()`
- `internal/ws/handler.go` — Accept state store, expose API endpoints for saving tab/pane state
- `frontend/src/App.tsx` — Wrap pane management in tab model, render BottomTabBar, sync state to backend
- `frontend/src/components/DiffPanel.tsx` — Use useResizableSplit instead of fixed `w-60`
- `frontend/src/components/FileExplorer.tsx` — Use useResizableSplit instead of fixed `w-64`
- `frontend/src/components/CommitsPanel.tsx` — Use useResizableSplit instead of fixed `w-72`

---

## Task 1: Add SQLite dependency

**Files:**
- Modify: `go.mod`

- [ ] **Step 1: Add modernc.org/sqlite dependency**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui
go get modernc.org/sqlite
go mod tidy
```

- [ ] **Step 2: Verify dependency was added**

```bash
grep modernc go.mod
```

Expected: A line like `modernc.org/sqlite v1.x.x`

- [ ] **Step 3: Verify build still works**

```bash
go build ./...
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add go.mod go.sum
git commit -m "Add modernc.org/sqlite dependency"
```

---

## Task 2: Implement internal/state package

**Files:**
- Create: `internal/state/state.go`

- [ ] **Step 1: Create the state package**

Create `internal/state/state.go` with the following content:

```go
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
	ID          string
	TabID       string
	SessionID   string
	Cwd         string
	WorktreeDir string
	Position    int
}

type Store struct {
	db *sql.DB
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
			id           TEXT PRIMARY KEY,
			tab_id       TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
			session_id   TEXT NOT NULL,
			cwd          TEXT NOT NULL,
			worktree_dir TEXT NOT NULL DEFAULT '',
			position     INTEGER NOT NULL
		);
	`)
	return err
}

// GetAuthToken returns the stored auth token, or empty string if none.
func (s *Store) GetAuthToken() (string, error) {
	var token string
	err := s.db.QueryRow("SELECT auth_token FROM config WHERE id = 1").Scan(&token)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return token, err
}

// SetAuthToken stores the auth token (upsert).
func (s *Store) SetAuthToken(token string) error {
	_, err := s.db.Exec(
		"INSERT INTO config (id, auth_token) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET auth_token = excluded.auth_token",
		token,
	)
	return err
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
	rows, err := s.db.Query("SELECT id, tab_id, session_id, cwd, worktree_dir, position FROM panes WHERE tab_id = ? ORDER BY position", tabID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var panes []Pane
	for rows.Next() {
		var p Pane
		if err := rows.Scan(&p.ID, &p.TabID, &p.SessionID, &p.Cwd, &p.WorktreeDir, &p.Position); err != nil {
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
		if _, err := tx.Exec("INSERT INTO panes (id, tab_id, session_id, cwd, worktree_dir, position) VALUES (?, ?, ?, ?, ?, ?)",
			p.ID, p.TabID, p.SessionID, p.Cwd, p.WorktreeDir, p.Position); err != nil {
			return err
		}
	}

	return tx.Commit()
}
```

- [ ] **Step 2: Verify it compiles**

```bash
go build ./internal/state/...
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add internal/state/state.go
git commit -m "Add internal/state package with SQLite store"
```

---

## Task 3: Auth token persistence

**Files:**
- Modify: `internal/auth/auth.go`
- Modify: `cmd/oriel/main.go`

- [ ] **Step 1: Update auth.go to support loading from store**

Replace `internal/auth/auth.go` with:

```go
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"time"

	"github.com/ryotarai/oriel/internal/state"
)

const cookieName = "oriel-token"

// generateToken returns a cryptographically random hex token.
func generateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// LoadOrGenerateToken loads the auth token from the store, or generates a new
// one and saves it.
func LoadOrGenerateToken(store *state.Store) string {
	token, err := store.GetAuthToken()
	if err != nil {
		log.Printf("Failed to load auth token: %v, generating new one", err)
	}
	if token != "" {
		return token
	}
	token = generateToken()
	if err := store.SetAuthToken(token); err != nil {
		log.Printf("Failed to save auth token: %v", err)
	}
	return token
}

// Middleware returns an http.Handler that checks for a valid token in the
// query string or cookie. On first access with ?token=..., it sets a cookie
// so subsequent requests don't need the query parameter.
func Middleware(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check cookie first
		if c, err := r.Cookie(cookieName); err == nil && c.Value == token {
			next.ServeHTTP(w, r)
			return
		}

		// Check query parameter
		if r.URL.Query().Get("token") == token {
			http.SetCookie(w, &http.Cookie{
				Name:     cookieName,
				Value:    token,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
				MaxAge:   int((30 * 24 * time.Hour).Seconds()),
			})
			// Redirect to strip token from URL (only for page loads, not API/WS)
			if r.Header.Get("Upgrade") == "" && !isAPI(r.URL.Path) {
				clean := *r.URL
				q := clean.Query()
				q.Del("token")
				clean.RawQuery = q.Encode()
				http.Redirect(w, r, clean.String(), http.StatusFound)
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		http.Error(w, "Unauthorized", http.StatusUnauthorized)
	})
}

func isAPI(path string) bool {
	return len(path) >= 4 && path[:4] == "/api" || path == "/ws"
}
```

- [ ] **Step 2: Update main.go to open store and use LoadOrGenerateToken**

In `cmd/oriel/main.go`, add the `state` import and replace the token generation. Change the beginning of `main()`:

Replace:
```go
	token := auth.GenerateToken()

	handler := ws.NewHandler(*command)
```

With:
```go
	store, err := state.Open(state.DefaultPath())
	if err != nil {
		log.Fatalf("Failed to open state database: %v", err)
	}
	defer store.Close()

	token := auth.LoadOrGenerateToken(store)

	handler := ws.NewHandler(*command, store)
```

Add the import `"github.com/ryotarai/oriel/internal/state"` to the imports block.

- [ ] **Step 3: Add DefaultPath helper to state package**

Add to `internal/state/state.go`:

```go
// DefaultPath returns the default state database path: ~/.config/oriel/state.sqlite3
func DefaultPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "oriel", "state.sqlite3")
}
```

- [ ] **Step 4: Temporarily update ws.NewHandler signature**

In `internal/ws/handler.go`, update the Handler struct and NewHandler to accept (but not yet use) the store:

Add import `"github.com/ryotarai/oriel/internal/state"`.

Replace lines 85-96 of `handler.go`:
```go
type Handler struct {
	command  string
	store    *state.Store
	mu       sync.Mutex
	sessions map[string]*session
}

func NewHandler(command string, store *state.Store) *Handler {
	return &Handler{
		command:  command,
		store:    store,
		sessions: make(map[string]*session),
	}
}
```

- [ ] **Step 5: Verify build**

```bash
go build ./...
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add internal/auth/auth.go internal/state/state.go cmd/oriel/main.go internal/ws/handler.go
git commit -m "Persist auth token in SQLite state database"
```

---

## Task 4: State save/restore API endpoints

**Files:**
- Modify: `internal/ws/handler.go`
- Modify: `cmd/oriel/main.go`

- [ ] **Step 1: Add state save endpoint to handler.go**

Add the following method to `internal/ws/handler.go`:

```go
// HandleSaveState saves the full tab/pane layout to the state database.
func (h *Handler) HandleSaveState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload struct {
		Tabs []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Position int    `json:"position"`
		} `json:"tabs"`
		Panes []struct {
			ID          string `json:"id"`
			TabID       string `json:"tabId"`
			SessionID   string `json:"sessionId"`
			Cwd         string `json:"cwd"`
			WorktreeDir string `json:"worktreeDir"`
			Position    int    `json:"position"`
		} `json:"panes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	tabs := make([]state.Tab, len(payload.Tabs))
	for i, t := range payload.Tabs {
		tabs[i] = state.Tab{ID: t.ID, Name: t.Name, Position: t.Position}
	}
	panes := make([]state.Pane, len(payload.Panes))
	for i, p := range payload.Panes {
		panes[i] = state.Pane{
			ID: p.ID, TabID: p.TabID, SessionID: p.SessionID,
			Cwd: p.Cwd, WorktreeDir: p.WorktreeDir, Position: p.Position,
		}
	}

	if err := h.store.SaveFullState(tabs, panes); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HandleLoadState returns the saved tab/pane layout from the state database.
func (h *Handler) HandleLoadState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	tabs, err := h.store.ListTabs()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type paneJSON struct {
		ID          string `json:"id"`
		TabID       string `json:"tabId"`
		SessionID   string `json:"sessionId"`
		Cwd         string `json:"cwd"`
		WorktreeDir string `json:"worktreeDir"`
		Position    int    `json:"position"`
	}
	type tabJSON struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Position int    `json:"position"`
	}

	respTabs := make([]tabJSON, len(tabs))
	var respPanes []paneJSON

	for i, t := range tabs {
		respTabs[i] = tabJSON{ID: t.ID, Name: t.Name, Position: t.Position}
		panes, err := h.store.ListPanes(t.ID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for _, p := range panes {
			respPanes = append(respPanes, paneJSON{
				ID: p.ID, TabID: p.TabID, SessionID: p.SessionID,
				Cwd: p.Cwd, WorktreeDir: p.WorktreeDir, Position: p.Position,
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"tabs":  respTabs,
		"panes": respPanes,
	})
}
```

- [ ] **Step 2: Register routes in main.go**

In `cmd/oriel/main.go`, add routes after the existing `mux.HandleFunc` lines (around line 50):

```go
	mux.HandleFunc("/api/state", handler.HandleLoadState)
	mux.HandleFunc("/api/state/save", handler.HandleSaveState)
```

- [ ] **Step 3: Verify build**

```bash
go build ./...
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add internal/ws/handler.go cmd/oriel/main.go
git commit -m "Add state save/restore API endpoints"
```

---

## Task 5: Update worktree tracking to notify state save

**Files:**
- Modify: `internal/ws/handler.go`

When a session's worktreeDir changes, we need the frontend to know so it can save the updated state. The existing `worktree_changed` WebSocket message already handles this. The frontend will trigger a state save when it processes this message (handled in Task 8).

This task is a no-op on the backend — the existing broadcast of `worktree_changed` is sufficient. Skip to the next task.

---

## Task 6: Bottom tab bar component

**Files:**
- Create: `frontend/src/components/BottomTabBar.tsx`

- [ ] **Step 1: Create the BottomTabBar component**

Create `frontend/src/components/BottomTabBar.tsx`:

```tsx
import { useState, useRef, useEffect, useCallback } from "react";

export interface TabInfo {
  id: string;
  name: string;
}

interface BottomTabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onAddTab: () => void;
  onDeleteTab: (id: string) => void;
  onRenameTab: (id: string, name: string) => void;
}

export function BottomTabBar({ tabs, activeTabId, onSelectTab, onAddTab, onDeleteTab, onRenameTab }: BottomTabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [contextMenu]);

  const startRename = useCallback((id: string, currentName: string) => {
    setEditingId(id);
    setEditValue(currentName);
    setContextMenu(null);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId && editValue.trim()) {
      onRenameTab(editingId, editValue.trim());
    }
    setEditingId(null);
  }, [editingId, editValue, onRenameTab]);

  return (
    <div className="flex items-center bg-gray-900 border-t border-gray-700 h-8 px-1 gap-0.5 flex-shrink-0">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelectTab(tab.id)}
          onDoubleClick={() => startRename(tab.id, tab.name)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ id: tab.id, x: e.clientX, y: e.clientY });
          }}
          className={`px-3 py-1 text-xs rounded-t transition-colors truncate max-w-[150px] ${
            tab.id === activeTabId
              ? "bg-gray-800 text-gray-100 border-t border-x border-gray-600"
              : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
          }`}
        >
          {editingId === tab.id ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
              className="bg-transparent border-none outline-none text-xs w-full text-gray-100"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            tab.name
          )}
        </button>
      ))}
      <button
        onClick={onAddTab}
        className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 rounded transition-colors"
        title="New tab"
      >
        +
      </button>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-gray-800 border border-gray-600 rounded shadow-lg py-1 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y - 60 }}
        >
          <button
            onClick={() => startRename(contextMenu.id, tabs.find((t) => t.id === contextMenu.id)?.name ?? "")}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700"
          >
            Rename
          </button>
          {tabs.length > 1 && (
            <button
              onClick={() => {
                if (confirm("Delete this tab? All Claude sessions in this tab will be terminated.")) {
                  onDeleteTab(contextMenu.id);
                }
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify frontend build**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend
npm run build
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/BottomTabBar.tsx
git commit -m "Add BottomTabBar component"
```

---

## Task 7: Refactor App.tsx for tab model

**Files:**
- Modify: `frontend/src/App.tsx`

This is the largest task — wrapping existing pane management in a tab model and adding state sync.

- [ ] **Step 1: Rewrite App.tsx with tab model**

Replace the entire content of `frontend/src/App.tsx`:

```tsx
import { useState, useCallback, useRef, useEffect } from "react";
import { SettingsPage } from "./components/SettingsPage";
import { BottomTabBar } from "./components/BottomTabBar";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SessionPanel, type SessionPanelHandle } from "./SessionPanel";

interface PaneConfig {
  id: string;
  sessionId: string;
  cwd: string; // empty = process cwd
}

interface TabConfig {
  id: string;
  name: string;
  panes: PaneConfig[];
  splits: number[];
  activePaneIndex: number;
}

let tabCounter = 1;

function makeTab(name: string, cwd: string): TabConfig {
  const id = `tab-${Date.now()}-${tabCounter}`;
  tabCounter++;
  return {
    id,
    name,
    panes: [{ id: `pane-${Date.now()}`, sessionId: `session-${Date.now()}`, cwd }],
    splits: [],
    activePaneIndex: 0,
  };
}

export default function App() {
  const [tabs, setTabs] = useState<TabConfig[]>([makeTab("Tab 1", "")]);
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [showSettings, setShowSettings] = useState(false);
  const [appConfig, setAppConfig] = useState<{ swapEnterKeys: boolean }>({ swapEnterKeys: true });
  const paneRefs = useRef<Map<string, SessionPanelHandle>>(new Map());
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // Load saved state on mount
  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((data: { tabs: Array<{ id: string; name: string; position: number }>; panes: Array<{ id: string; tabId: string; sessionId: string; cwd: string; worktreeDir: string; position: number }> }) => {
        if (data.tabs && data.tabs.length > 0) {
          const loadedTabs: TabConfig[] = data.tabs
            .sort((a, b) => a.position - b.position)
            .map((t) => {
              const tabPanes = data.panes
                .filter((p) => p.tabId === t.id)
                .sort((a, b) => a.position - b.position)
                .map((p) => ({ id: p.id, sessionId: p.sessionId, cwd: p.cwd }));
              // Update tabCounter to avoid collisions
              const num = parseInt(t.name.replace("Tab ", ""), 10);
              if (!isNaN(num) && num >= tabCounter) tabCounter = num + 1;
              return {
                id: t.id,
                name: t.name,
                panes: tabPanes.length > 0 ? tabPanes : [{ id: `pane-${Date.now()}`, sessionId: `session-${Date.now()}`, cwd: "" }],
                splits: [],
                activePaneIndex: 0,
              };
            });
          setTabs(loadedTabs);
          setActiveTabId(loadedTabs[0].id);
        }
        setInitialLoadDone(true);
      })
      .catch(() => setInitialLoadDone(true));
  }, []);

  // Save state whenever tabs change (after initial load)
  const saveState = useCallback((currentTabs: TabConfig[]) => {
    const tabsPayload = currentTabs.map((t, i) => ({ id: t.id, name: t.name, position: i }));
    const panesPayload = currentTabs.flatMap((t) =>
      t.panes.map((p, i) => ({
        id: p.id,
        tabId: t.id,
        sessionId: p.sessionId,
        cwd: p.cwd,
        worktreeDir: "",
        position: i,
      }))
    );
    fetch("/api/state/save", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabs: tabsPayload, panes: panesPayload }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialLoadDone) {
      saveState(tabs);
    }
  }, [tabs, initialLoadDone, saveState]);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setAppConfig).catch(() => {});
  }, [showSettings]);

  // Cmd+Left/Right pane navigation (scoped to active tab)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

      e.preventDefault();
      const targetIndex = e.key === "ArrowLeft" ? activeTab.activePaneIndex - 1 : activeTab.activePaneIndex + 1;
      if (targetIndex < 0 || targetIndex >= activeTab.panes.length) return;

      const targetPane = activeTab.panes[targetIndex];
      const handle = paneRefs.current.get(targetPane.id);
      if (handle) {
        handle.focus();
        updateActiveTab((tab) => ({ ...tab, activePaneIndex: targetIndex }));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab]);

  // Helper to update the active tab
  const updateActiveTab = useCallback((updater: (tab: TabConfig) => TabConfig) => {
    setTabs((prev) => prev.map((t) => t.id === activeTabId ? updater(t) : t));
  }, [activeTabId]);

  const addPaneAt = useCallback((afterIndex: number) => {
    updateActiveTab((tab) => {
      const sourceCwd = tab.panes[afterIndex]?.cwd ?? "";
      const newId = `pane-${Date.now()}`;
      const newSessionId = `session-${Date.now()}`;
      const next = [...tab.panes];
      next.splice(afterIndex + 1, 0, { id: newId, sessionId: newSessionId, cwd: sourceCwd });
      const positions: number[] = [];
      for (let i = 1; i < next.length; i++) {
        positions.push((i / next.length) * 100);
      }
      return { ...tab, panes: next, splits: positions };
    });
  }, [updateActiveTab]);

  const handleCwdChange = useCallback((paneId: string, newCwd: string) => {
    updateActiveTab((tab) => ({
      ...tab,
      panes: tab.panes.map((p) => p.id === paneId ? { ...p, cwd: newCwd } : p),
    }));
  }, [updateActiveTab]);

  const removePane = useCallback((id: string) => {
    updateActiveTab((tab) => {
      if (tab.panes.length <= 1) return tab;
      const next = tab.panes.filter((p) => p.id !== id);
      const positions: number[] = [];
      for (let i = 1; i < next.length; i++) {
        positions.push((i / next.length) * 100);
      }
      return { ...tab, panes: next, splits: positions };
    });
  }, [updateActiveTab]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    updateActiveTab((tab) => {
      const oldIndex = tab.panes.findIndex((p) => p.id === active.id);
      const newIndex = tab.panes.findIndex((p) => p.id === over.id);
      const newPanes = arrayMove(tab.panes, oldIndex, newIndex);
      const oldWidths = computeWidths(tab.panes.length, tab.splits);
      const newWidths = arrayMove(oldWidths, oldIndex, newIndex);
      const newSplits: number[] = [];
      let cumulative = 0;
      for (let i = 0; i < newWidths.length - 1; i++) {
        cumulative += newWidths[i];
        newSplits.push(cumulative);
      }
      return { ...tab, panes: newPanes, splits: newSplits };
    });
  }, [updateActiveTab]);

  // Tab management
  const addTab = useCallback(() => {
    const newTab = makeTab(`Tab ${tabCounter}`, "");
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const deleteTab = useCallback((id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next[0].id);
      }
      return next;
    });
  }, [activeTabId]);

  const renameTab = useCallback((id: string, name: string) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, name } : t));
  }, []);

  const paneWidths = computeWidths(activeTab.panes.length, activeTab.splits);

  return (
    <div className="h-screen w-screen bg-[#0a0a0f] flex flex-col overflow-hidden">
      {/* Main pane area */}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={activeTab.panes.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex-1 flex overflow-hidden relative min-h-0">
            {/* Settings button */}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="fixed bottom-10 right-2 z-20 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs px-2 py-0.5 rounded border border-gray-600"
              title="Settings"
            >
              ⚙
            </button>
            {showSettings && (
              <div className="absolute inset-0 z-30 bg-black/70 flex items-start justify-center pt-16">
                <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
                    <h2 className="text-gray-100 font-medium">Settings</h2>
                    <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-200 text-lg">×</button>
                  </div>
                  <SettingsPage />
                </div>
              </div>
            )}
            {activeTab.panes.map((pane, i) => (
              <PaneWithDivider
                key={pane.id}
                pane={pane}
                width={paneWidths[i]}
                isLast={i === activeTab.panes.length - 1}
                showClose={activeTab.panes.length > 1}
                onClose={() => removePane(pane.id)}
                onAdd={() => addPaneAt(i)}
                onDividerDrag={(posPct) => {
                  updateActiveTab((tab) => {
                    const next = [...tab.splits];
                    next[i] = Math.max(10, Math.min(90, posPct));
                    return { ...tab, splits: next };
                  });
                }}
                swapEnterKeys={appConfig.swapEnterKeys}
                onCwdChange={(newCwd) => handleCwdChange(pane.id, newCwd)}
                onRef={(handle) => {
                  if (handle) paneRefs.current.set(pane.id, handle);
                  else paneRefs.current.delete(pane.id);
                }}
                onFocus={() => updateActiveTab((tab) => ({ ...tab, activePaneIndex: i }))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Bottom tab bar */}
      <BottomTabBar
        tabs={tabs.map((t) => ({ id: t.id, name: t.name }))}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onAddTab={addTab}
        onDeleteTab={deleteTab}
        onRenameTab={renameTab}
      />
    </div>
  );
}

function computeWidths(count: number, splits: number[]): number[] {
  if (count === 1) return [100];
  const points = [0, ...splits, 100];
  const widths: number[] = [];
  for (let i = 0; i < count; i++) {
    widths.push((points[i + 1] ?? 100) - (points[i] ?? 0));
  }
  return widths;
}

interface PaneWithDividerProps {
  pane: PaneConfig;
  width: number;
  isLast: boolean;
  showClose: boolean;
  onClose: () => void;
  onAdd: () => void;
  onDividerDrag: (posPct: number) => void;
  swapEnterKeys: boolean;
  onCwdChange: (newCwd: string) => void;
  onRef: (handle: SessionPanelHandle | null) => void;
  onFocus: () => void;
}

function PaneWithDivider({ pane, width, isLast, showClose, onClose, onAdd, onDividerDrag, swapEnterKeys, onCwdChange, onRef, onFocus }: PaneWithDividerProps) {
  const sessionRef = useRef<SessionPanelHandle>(null);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pane.id });

  const style: React.CSSProperties = {
    width: `${width}%`,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      const onMove = (ev: MouseEvent) => {
        const posPct = (ev.clientX / window.innerWidth) * 100;
        onDividerDrag(posPct);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [onDividerDrag],
  );

  useEffect(() => {
    onRef(sessionRef.current);
    return () => onRef(null);
  });

  useEffect(() => {
    const el = paneContainerRef.current;
    if (!el) return;
    const handler = () => onFocus();
    el.addEventListener("focusin", handler);
    return () => el.removeEventListener("focusin", handler);
  }, [onFocus]);

  return (
    <>
      <div
        ref={(node) => { setNodeRef(node); (paneContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = node; }}
        style={style}
        className="h-full min-w-0 relative"
      >
        {/* Toolbar */}
        <div className="absolute top-1 right-1 z-10 flex gap-1">
          <button
            onClick={() => sessionRef.current?.openCwdPicker()}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
            title="Change working directory"
          >
            📁
          </button>
          <button
            onClick={() => sessionRef.current?.openResumeModal()}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
            title="Resume session"
          >
            ↻
          </button>
          <button
            onClick={onAdd}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
            title="Add pane"
          >
            +
          </button>
          {showClose && (
            <button
              onClick={onClose}
              className="bg-gray-800 hover:bg-red-800 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
              title="Close pane"
            >
              ×
            </button>
          )}
        </div>
        <SessionPanel
          ref={sessionRef}
          sessionId={pane.sessionId}
          dragHandleProps={{ ...attributes, ...listeners }}
          swapEnterKeys={swapEnterKeys}
          cwd={pane.cwd}
          onCwdChange={onCwdChange}
        />
      </div>
      {!isLast && (
        <div
          onMouseDown={onDividerMouseDown}
          className="w-1.5 bg-gray-800 hover:bg-blue-600 cursor-col-resize flex-shrink-0 transition-colors"
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify frontend build**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend
npm run build
```

Expected: No errors

- [ ] **Step 3: Verify full build**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui
go build ./...
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "Refactor App.tsx for tab model with state persistence"
```

---

## Task 8: State restoration — resume sessions on startup

**Files:**
- Modify: `internal/ws/handler.go`

When the frontend loads saved state and connects via WebSocket with a saved `sessionId`, `getOrCreateSession` already starts a fresh Claude process. We need to make it resume the saved session instead.

- [ ] **Step 1: Add resume support to getOrCreateSession**

The frontend will pass `resume=true` as a WebSocket query parameter when restoring state. Update `ServeHTTP` in `handler.go` to support this.

In `handler.go`, in the `ServeHTTP` method, after extracting `cwd` (around line 402), add resume handling:

Replace lines 397-408:
```go
	sessionID := r.URL.Query().Get("session")
	if sessionID == "" {
		sessionID = "default"
	}

	cwd := r.URL.Query().Get("cwd")
	s, err := h.getOrCreateSession(sessionID, cwd)
	if err != nil {
		log.Printf("Start session %s: %v", sessionID, err)
		conn.WriteJSON(message{Type: "error", Data: err.Error()})
		return
	}
```

With:
```go
	sessionID := r.URL.Query().Get("session")
	if sessionID == "" {
		sessionID = "default"
	}

	cwd := r.URL.Query().Get("cwd")
	resumeID := r.URL.Query().Get("resume")
	s, err := h.getOrCreateSession(sessionID, cwd, resumeID)
	if err != nil {
		log.Printf("Start session %s: %v", sessionID, err)
		conn.WriteJSON(message{Type: "error", Data: err.Error()})
		return
	}
```

- [ ] **Step 2: Update getOrCreateSession to accept resumeID**

Replace the `getOrCreateSession` method:

```go
func (h *Handler) getOrCreateSession(id string, cwd string, resumeID string) (*session, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if s, ok := h.sessions[id]; ok {
		return s, nil
	}

	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	s := &session{
		id:        id,
		subs:      make(map[*subscriber]struct{}),
		cols:      120,
		rows:      40,
		cwd:       cwd,
		restartCh: make(chan restartRequest, 1),
	}
	h.sessions[id] = s

	// If resuming a previous Claude session, pass --resume flag
	var args []string
	if resumeID != "" {
		args = []string{"--resume", resumeID}
		// Pre-load conversation history from the old session
		oldEntries := conversation.ReadSessionEntries(cwd, resumeID)
		if len(oldEntries) > 0 {
			s.convHistory = append(s.convHistory, oldEntries...)
		}
	}

	if err := h.startProcess(s, args...); err != nil {
		delete(h.sessions, id)
		return nil, err
	}

	go h.restartLoop(s)

	return s, nil
}
```

- [ ] **Step 3: Update frontend to pass resume parameter**

In `frontend/src/SessionPanel.tsx`, find the WebSocket URL construction (around line 191-193). We need the component to accept a `resume` prop.

Update `SessionPanelProps` interface:
```typescript
interface SessionPanelProps {
  sessionId: string;
  dragHandleProps?: Record<string, unknown>;
  swapEnterKeys?: boolean;
  cwd?: string;
  onCwdChange?: (newCwd: string) => void;
  resume?: boolean; // true = use claude --resume with sessionId
}
```

Update the `forwardRef` function signature to include `resume`:
```typescript
export const SessionPanel = forwardRef<SessionPanelHandle, SessionPanelProps>(function SessionPanel({ sessionId, dragHandleProps, swapEnterKeys, cwd, onCwdChange, resume }, ref) {
```

Update the WebSocket URL construction to include the resume parameter. Find the line that constructs the WebSocket URL (around line 191):
```typescript
      const wsUrl = `${wsProto}//${location.host}/ws?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd ?? "")}`;
```

Replace with:
```typescript
      const resumeParam = resume ? `&resume=${encodeURIComponent(sessionId)}` : "";
      const wsUrl = `${wsProto}//${location.host}/ws?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd ?? "")}${resumeParam}`;
```

- [ ] **Step 4: Pass resume prop from App.tsx**

In `App.tsx`, track which sessions are restored. Add state:

After the `initialLoadDone` state, add:
```typescript
  const [restoredSessionIds] = useState<Set<string>>(new Set());
```

In the state loading effect, when loading panes, collect session IDs:
Inside the `.then` callback where `loadedTabs` is built, after `setTabs(loadedTabs)`:
```typescript
          loadedTabs.forEach((t) => t.panes.forEach((p) => restoredSessionIds.add(p.sessionId)));
```

Then in the `SessionPanel` render, pass the resume prop:
```tsx
        <SessionPanel
          ref={sessionRef}
          sessionId={pane.sessionId}
          dragHandleProps={{ ...attributes, ...listeners }}
          swapEnterKeys={swapEnterKeys}
          cwd={pane.cwd}
          onCwdChange={onCwdChange}
          resume={restoredSessionIds.has(pane.sessionId)}
        />
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui
cd frontend && npm run build && cd .. && go build ./...
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add internal/ws/handler.go frontend/src/SessionPanel.tsx frontend/src/App.tsx
git commit -m "Add session restoration with claude --resume on startup"
```

---

## Task 9: Draggable split hook

**Files:**
- Create: `frontend/src/hooks/useResizableSplit.ts`

- [ ] **Step 1: Create the useResizableSplit hook**

Create `frontend/src/hooks/useResizableSplit.ts`:

```typescript
import { useState, useCallback, useRef } from "react";

interface UseResizableSplitOptions {
  defaultWidth: number; // px
  minWidth?: number;    // px, default 150
  maxWidthPct?: number; // % of container, default 50
}

export function useResizableSplit({ defaultWidth, minWidth = 150, maxWidthPct = 50 }: UseResizableSplitOptions) {
  const [leftWidth, setLeftWidth] = useState(defaultWidth);
  const containerRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const maxWidth = rect.width * (maxWidthPct / 100);
      const newWidth = Math.max(minWidth, Math.min(maxWidth, ev.clientX - rect.left));
      setLeftWidth(newWidth);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [minWidth, maxWidthPct]);

  return { leftWidth, containerRef, onMouseDown };
}
```

- [ ] **Step 2: Verify frontend build**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend
npm run build
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useResizableSplit.ts
git commit -m "Add useResizableSplit hook for draggable panel split"
```

---

## Task 10: Apply draggable split to DiffPanel

**Files:**
- Modify: `frontend/src/components/DiffPanel.tsx`

- [ ] **Step 1: Update DiffPanel to use useResizableSplit**

In `DiffPanel.tsx`, add the import at the top:

```typescript
import { useResizableSplit } from "../hooks/useResizableSplit";
```

Inside the `DiffPanel` component function, add the hook call after the existing state declarations (after line 37 `const [wrapLines, setWrapLines] = useState(true);`):

```typescript
  const { leftWidth, containerRef: splitContainerRef, onMouseDown: onSplitMouseDown } = useResizableSplit({ defaultWidth: 240 });
```

Replace the two-pane layout div (lines 75-120):

Replace:
```tsx
      <div className="flex flex-1 min-h-0">
        {/* File tree (left) */}
        <div className="w-60 flex-shrink-0 border-r border-gray-800 overflow-y-auto">
```

With:
```tsx
      <div ref={splitContainerRef} className="flex flex-1 min-h-0">
        {/* File tree (left) */}
        <div className="flex-shrink-0 border-r border-gray-800 overflow-y-auto" style={{ width: leftWidth }}>
```

After the left pane closing `</div>` and before the right pane opening, add the drag handle:

```tsx
        {/* Resize handle */}
        <div
          onMouseDown={onSplitMouseDown}
          className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-600 transition-colors"
        />
```

- [ ] **Step 2: Verify frontend build**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend
npm run build
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/DiffPanel.tsx
git commit -m "Add draggable split to DiffPanel"
```

---

## Task 11: Apply draggable split to FileExplorer

**Files:**
- Modify: `frontend/src/components/FileExplorer.tsx`

- [ ] **Step 1: Update FileExplorer to use useResizableSplit**

Add the import at the top:

```typescript
import { useResizableSplit } from "../hooks/useResizableSplit";
```

Inside the `FileExplorer` component function, after the existing state declarations (after line 18 `const [wrapLines, setWrapLines] = useState(true);`), add:

```typescript
  const { leftWidth, containerRef: splitContainerRef, onMouseDown: onSplitMouseDown } = useResizableSplit({ defaultWidth: 256 });
```

Replace the two-pane container (line 82):

Replace:
```tsx
      <div className="flex flex-1 min-h-0">
        {/* File tree (left pane) */}
        <div className="w-64 flex-shrink-0 border-r border-gray-700 overflow-y-auto text-sm">
```

With:
```tsx
      <div ref={splitContainerRef} className="flex flex-1 min-h-0">
        {/* File tree (left pane) */}
        <div className="flex-shrink-0 border-r border-gray-700 overflow-y-auto text-sm" style={{ width: leftWidth }}>
```

After the left pane closing `</div>` (which closes the tree section, around line 100) and before the right pane `{/* File viewer (right pane) */}` comment, add:

```tsx
        {/* Resize handle */}
        <div
          onMouseDown={onSplitMouseDown}
          className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-600 transition-colors"
        />
```

- [ ] **Step 2: Verify frontend build**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend
npm run build
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/FileExplorer.tsx
git commit -m "Add draggable split to FileExplorer"
```

---

## Task 12: Apply draggable split to CommitsPanel

**Files:**
- Modify: `frontend/src/components/CommitsPanel.tsx`

- [ ] **Step 1: Update CommitsPanel to use useResizableSplit**

Add the import at the top:

```typescript
import { useResizableSplit } from "../hooks/useResizableSplit";
```

Inside the `CommitsPanel` component function, after the existing state declarations (after line 22 `const [loading, setLoading] = useState(false);`), add:

```typescript
  const { leftWidth, containerRef: splitContainerRef, onMouseDown: onSplitMouseDown } = useResizableSplit({ defaultWidth: 288 });
```

Replace the two-pane container (line 51):

Replace:
```tsx
      <div className="flex flex-1 min-h-0">
      {/* Commit list (left) */}
      <div className="w-72 flex-shrink-0 border-r border-gray-800 overflow-y-auto">
```

With:
```tsx
      <div ref={splitContainerRef} className="flex flex-1 min-h-0">
      {/* Commit list (left) */}
      <div className="flex-shrink-0 border-r border-gray-800 overflow-y-auto" style={{ width: leftWidth }}>
```

After the left pane closing `</div>` (around line 72) and before `{/* Commit detail (right) */}`, add:

```tsx
      {/* Resize handle */}
      <div
        onMouseDown={onSplitMouseDown}
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-600 transition-colors"
      />
```

- [ ] **Step 2: Verify frontend build**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui/frontend
npm run build
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/CommitsPanel.tsx
git commit -m "Add draggable split to CommitsPanel"
```

---

## Task 13: Full integration test

**Files:** None (manual testing)

- [ ] **Step 1: Build and run**

```bash
cd /Users/r-arai/src/github.com/ryotarai/claude-code-wrapper-ui
cd frontend && npm run build && cd .. && go build -o oriel ./cmd/oriel && ./oriel --no-open
```

- [ ] **Step 2: Verify auth token persistence**

1. Note the token in the startup URL
2. Stop the server (Ctrl-C → y)
3. Start again — verify same token is used (same URL)

- [ ] **Step 3: Verify bottom tabs**

1. Open the URL — should see "Tab 1" at bottom with one pane
2. Click `+` to add "Tab 2" — should switch to new tab with fresh pane
3. Switch between tabs — panes should swap
4. Double-click tab name to rename
5. Right-click tab → Delete (with warning)

- [ ] **Step 4: Verify state restoration**

1. Create 2 tabs with multiple panes
2. Stop and restart the server
3. All tabs and panes should restore, sessions should resume

- [ ] **Step 5: Verify draggable split**

1. Open Diff/Files/Commits tab
2. Drag the border between left list and right content
3. Verify it resizes smoothly with min/max constraints

- [ ] **Step 6: Verify SQLite permissions**

```bash
ls -la ~/.config/oriel/state.sqlite3
```

Expected: `-rw-------` (0600)

- [ ] **Step 7: Update tasks file**

Mark all 5 tasks as completed in `tmp/tasks.md`.
