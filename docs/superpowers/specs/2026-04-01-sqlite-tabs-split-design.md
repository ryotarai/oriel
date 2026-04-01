# SQLite State Persistence, Bottom Tabs, Draggable Split — Design Spec

## Overview

Five remaining tasks from `tmp/tasks.md`, grouped into three functional areas:

1. **SQLite基盤** — `state.sqlite3` 導入、auth token永続化、パーミッション0600
2. **Bottom Tabs** — 画面全体を切り替えるタブシステム、各タブがpanesを持つ
3. **Draggable Split** — Diff/Files/Commitsタブの左右分割位置をドラッグで変更

## 1. SQLite State Persistence

### Database

- **Path:** `~/.config/oriel/state.sqlite3`
- **Permissions:** `0600` (owner read/write only)
- **Driver:** `modernc.org/sqlite` (Pure Go, no CGO)

### Schema

```sql
CREATE TABLE config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  auth_token  TEXT NOT NULL
);

CREATE TABLE tabs (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  position  INTEGER NOT NULL
);

CREATE TABLE panes (
  id           TEXT PRIMARY KEY,
  tab_id       TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  worktree_dir TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL
);
```

### Package: `internal/state/state.go`

`Store` struct with methods:

- `Open(path string) (*Store, error)` — open/create DB, run migrations, set permissions 0600
- `Close() error`
- `GetAuthToken() (string, error)` / `SetAuthToken(token string) error`
- `ListTabs() ([]Tab, error)` / `SaveTab(tab Tab) error` / `DeleteTab(id string) error`
- `ListPanes(tabID string) ([]Pane, error)` / `SavePane(pane Pane) error` / `DeletePane(id string) error`
- `DeletePanesByTabID(tabID string) error`
- `SaveFullState(tabs []Tab, panes []Pane) error` — トランザクションで全状態を保存

### Auth Token Persistence

- 起動時: `state.sqlite3` から auth_token を読み込み
- なければ新規生成して保存
- `internal/auth/auth.go` の変更: `GenerateToken()` → `LoadOrGenerateToken(store *state.Store)`
- サーバー再起動後も同じトークン → 既存cookieが有効なまま

### State Restoration on Startup

- 起動時に `state.sqlite3` からタブ・ペイン一覧を読み込み
- 各ペインのsession_idを使って `claude --resume <session_id>` で再開
- 復元時のpane幅は均等割（splitsは保存しない）
- DB にデータがない場合は従来通り（1タブ1ペインで起動）

### State Persistence Timing

- pane追加/削除、タブ追加/削除/リネーム、cwd変更、worktreeDir変更のたびに即時保存
- フロントエンドからWebSocket経由でバックエンドに通知、バックエンドがDB更新

## 2. Bottom Tabs

### Frontend Data Model

```typescript
interface TabConfig {
  id: string;        // "tab-{timestamp}"
  name: string;      // "Tab 1", "Tab 2", ... (user renamable)
  panes: PaneConfig[];
  splits: number[];
  activePaneIndex: number;
}

// App.tsx state
tabs: TabConfig[]
activeTabId: string
```

### UI

- 画面最下部にタブバー
- 各タブ: タブ名表示、ダブルクリックでinline inputによるリネーム
- 右端に `+` ボタン → 新タブ作成（Orielのcwdでpane1つ）、自動切り替え
- 右クリック → コンテキストメニューに「Delete」
  - 「タブ内の全Claudeセッションが終了されます」の警告表示
  - タブが1つだけの場合はDelete不可（メニューに表示しないかdisabled）
- タブ切り替え時: アクティブタブのpanesのみ表示、非アクティブタブのセッションはバックグラウンドで維持

### Tab Auto-Naming

- 新規タブは "Tab N" (N = 現在の最大番号 + 1)
- リネーム後は手動名を維持

### Backend Interaction

- タブ・ペインの変更時にWebSocket経由でバックエンドへ通知
- バックエンドが `state.sqlite3` に保存
- タブ削除時: 含まれるペインの全セッションをkill

### Existing Code Impact

- `App.tsx` の `panes`/`splits` 管理をタブ単位に変更
- pane追加/削除/ドラッグ操作はアクティブタブに対して作用
- Cmd+Left/Right のpaneフォーカス移動はアクティブタブ内のみ

## 3. Draggable Split Position

### Target

Diff/Files/Commitsタブの左ペイン（リスト）と右ペイン（内容表示）の境界

### Implementation

- 左右ペイン間にドラッグハンドル（幅4px、ホバーでカーソル `col-resize`）
- mousedown/mousemove/mouseup ハンドラでリアルタイムリサイズ
- 左ペイン最小幅: 150px、最大幅: コンテナの50%
- React stateとしてSessionPanel内で保持（paneごと、永続化なし）
- Diff/Files/Commitsの3タブで同じ分割位置を共有（pane内で1つの値）
- 外部ライブラリ不使用

### Affected Components

- `DiffPanel.tsx`
- `FileExplorer.tsx`
- `CommitsPanel.tsx`

共通のリサイズロジックはカスタムhookまたは共通コンポーネントとして抽出。
