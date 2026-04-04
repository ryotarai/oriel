# Tier 1: Quick Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three frontend-focused bugs: links not clickable (#2), `!command` stuck running (#3), slash command raw XML display (#6).

**Architecture:** All three fixes are in `frontend/src/SessionPanel.tsx`. Issue #2 requires adding `e.stopPropagation()` + explicit `window.open()` on link clicks. Issue #3 requires detecting `<bash-input>` / `<command-name>` tagged user entries and not treating them as "running". Issue #6 requires parsing `<command-name>` XML tags and rendering a styled badge.

**Tech Stack:** React 19, TypeScript, Tailwind CSS

**Verification:** `cd frontend && npx tsc -b && npx vitest run` for type checks, `make build` for full build. Playwright for manual verification.

---

### Task 1: Fix links not clickable in conversation tab (Issue #2)

**Problem:** The `<a>` tag rendered by ReactMarkdown has `target="_blank"` but clicking does nothing. Root cause: the parent `chatScrollRef` div (line 665-672) has an `onClick` handler that calls `termRef.current?.focus()` on every click. This steals focus from the link before the browser can navigate.

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:1068-1070` (link component in ReactMarkdown)

- [ ] **Step 1: Fix the link `a` component to stop propagation and open explicitly**

In `frontend/src/SessionPanel.tsx`, replace the `a` component inside the ReactMarkdown `components` prop:

```tsx
// Before (line 1068-1070):
a: ({ children, ...props }) => (
  <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
),

// After:
a: ({ children, href, ...props }) => (
  <a
    {...props}
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => {
      e.stopPropagation();
      if (href) {
        e.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
      }
    }}
  >
    {children}
  </a>
),
```

- [ ] **Step 2: Verify build passes**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel/frontend && npx tsc -b`
Expected: No errors

- [ ] **Step 3: Verify with Playwright**

Open the app, find a conversation with links, click a link, confirm it opens in a new tab.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Fix links not clickable in conversation tab"
```

---

### Task 2: Fix `!command` and slash commands leaving pane stuck in running state (Issue #3)

**Problem:** Running state is determined by `setRunning(last.type !== "assistant")` (line 403). When `!command` is executed, two `type: "user"` entries are added to JSONL:
- `<bash-input>echo hello</bash-input>`
- `<bash-stdout>hello</bash-stdout><bash-stderr></bash-stderr>`

These pass through the watcher as user entries, so `running` stays `true` until the next assistant response.

Similarly, slash commands produce `<command-name>/foo</command-name>` entries.

**Fix:** Detect these special user entries (bash tags or command-name tags) and exclude them from the running state calculation. Look at the last entry that is NOT one of these special entries.

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:394-404` (running state detection)

- [ ] **Step 1: Add helper function to detect local command / slash command entries**

Add this function near the other helper functions (after `shouldShowTimestamp` around line 994):

```tsx
/** Returns true if this user entry is a local command (!command) or slash command, not a real user prompt. */
function isLocalOrSlashCommand(entry: ConversationEntry): boolean {
  if (entry.role !== "user") return false;
  const t = entry.text;
  return (
    t.startsWith("<bash-input>") ||
    t.startsWith("<bash-stdout>") ||
    t.startsWith("<bash-stderr>") ||
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command-caveat>") ||
    t.startsWith("<local-command-stdout>")
  );
}
```

- [ ] **Step 2: Update running state detection to skip local/slash command entries**

Replace the running state useEffect (lines 394-404):

```tsx
// Before:
useEffect(() => {
  if (entries.length === 0) {
    setRunning(false);
    return;
  }
  const last = entries[entries.length - 1];
  setRunning(last.type !== "assistant");
}, [entries]);

// After:
useEffect(() => {
  if (entries.length === 0) {
    setRunning(false);
    return;
  }
  // Find the last entry that is not a local command or slash command
  let last = entries[entries.length - 1];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isLocalOrSlashCommand(entries[i])) {
      last = entries[i];
      break;
    }
  }
  setRunning(last.type !== "assistant");
}, [entries]);
```

- [ ] **Step 3: Verify build passes**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel/frontend && npx tsc -b`
Expected: No errors

- [ ] **Step 4: Verify with Playwright**

Open the app, run `! echo hello` in the terminal, confirm the pane border does not stay in "running" (blue) state after the command completes.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Fix !command leaving pane stuck in running state"
```

---

### Task 3: Better UI for slash command messages (Issue #6)

**Problem:** Slash command entries appear as raw XML: `<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>`. The user message rendering (line 1034-1040) displays `entry.text` as-is.

**Fix:** In `MessageBubble`, detect slash command entries and render them as a styled chip/badge.

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:1021-1040` (user message rendering in MessageBubble)

- [ ] **Step 1: Add slash command parser and styled component**

Add a parser function near `parseBashTags` (around line 944):

```tsx
function parseSlashCommand(text: string): { name: string; args: string } | null {
  const nameMatch = text.match(/<command-name>(.*?)<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>(.*?)<\/command-args>/s);
  return {
    name: nameMatch[1],
    args: argsMatch?.[1]?.trim() ?? "",
  };
}
```

- [ ] **Step 2: Update MessageBubble to render slash commands as badges**

In the `MessageBubble` function, add a check for slash commands right after the `parseBashTags` check (after line 1029):

```tsx
// After the bash block check, before the meta marker skip:
const slashCmd = parseSlashCommand(entry.text);
if (slashCmd) {
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-1 rounded-full bg-gray-800 border border-gray-700 px-3 py-1 text-xs text-gray-400">
        <span className="font-mono">{slashCmd.name}</span>
        {slashCmd.args && <span className="text-gray-500">{slashCmd.args}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Also hide `<local-command-caveat>` entries**

These are meta entries that shouldn't be shown. Add a check before the meta marker skip (line 1032):

```tsx
// Skip local-command-caveat entries
if (entry.text.startsWith("<local-command-caveat>")) return null;
```

- [ ] **Step 4: Verify build passes**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel/frontend && npx tsc -b`
Expected: No errors

- [ ] **Step 5: Verify with Playwright**

Open the app, run a slash command like `/help`, confirm it displays as a styled badge instead of raw XML.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Render slash commands as styled badges instead of raw XML"
```
