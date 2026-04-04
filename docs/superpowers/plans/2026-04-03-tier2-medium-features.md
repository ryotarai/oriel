# Tier 2: Medium Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four medium-complexity features: "Show only changed files" toggle (#5), Markdown viewer in Files tab (#11), Mermaid rendering (#4), and ExitWorktree cwd fix (#1).

**Architecture:** Issues #5, #11, #4 are frontend-only changes in FileExplorer.tsx and SessionPanel.tsx. Issue #1 is a one-line frontend fix in SessionPanel.tsx.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, react-markdown, mermaid

---

### Task 1: Fix ExitWorktree cwd not reflected in tabs (Issue #1)

**Problem:** When `worktree_changed` message arrives with empty data (ExitWorktree), the condition `msg.type === "worktree_changed" && msg.data` on line 238 of SessionPanel.tsx is falsy because `msg.data` is `""`. So `worktreeDir` never gets cleared, and all tabs keep using the old worktree path.

**Files:**
- Modify: `frontend/src/SessionPanel.tsx:238`

- [ ] **Step 1: Fix the worktree_changed handler to accept empty data**

In `frontend/src/SessionPanel.tsx`, change line 238:

```tsx
// Before:
} else if (msg.type === "worktree_changed" && msg.data) {
  setWorktreeDir(msg.data);

// After:
} else if (msg.type === "worktree_changed") {
  setWorktreeDir(msg.data || "");
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel/frontend && npx tsc -b`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/SessionPanel.tsx
git commit -m "Fix ExitWorktree not updating cwd in tabs"
```

---

### Task 2: "Show only changed files" toggle in Files tab (Issue #5)

**Problem:** Files tab always shows the full directory tree. Users want to filter to only files with uncommitted git changes.

**Approach:** Add a "Changed only" toggle to FileExplorer. When active, fetch the list of changed file paths from the existing `/api/diff` endpoint and filter the tree to only show those paths (and their parent directories).

**Files:**
- Modify: `frontend/src/components/FileExplorer.tsx`

- [ ] **Step 1: Add state and fetch for changed files**

Add state for the toggle and changed file paths. In `FileExplorer` component, add after existing state declarations (around line 19):

```tsx
const [changedOnly, setChangedOnly] = useState(false);
const [changedPaths, setChangedPaths] = useState<Set<string>>(new Set());

// Fetch changed file paths from diff API
useEffect(() => {
  if (!changedOnly) return;
  const cwdParam = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  fetch(`/api/diff${cwdParam.replace("?", "?session=default&")}`)
    .then((r) => r.json())
    .then((data: { files?: { path: string }[] }) => {
      setChangedPaths(new Set((data.files ?? []).map((f) => f.path)));
    })
    .catch(() => {});
}, [changedOnly, cwd]);
```

Wait — the diff API requires a `session` param. Let me check.

Actually, looking at DiffPanel usage in SessionPanel.tsx, the diff polling is done in SessionPanel and passed as props. A simpler approach: pass the `diffFiles` list from SessionPanel to FileExplorer as an optional prop.

- [ ] **Step 1: Add changedPaths prop to FileExplorer**

In `frontend/src/components/FileExplorer.tsx`, update the component signature and add filtering:

```tsx
export function FileExplorer({ requestedPath, onSendInput, cwd, changedPaths }: {
  requestedPath?: string | null;
  onSendInput?: (text: string) => void;
  cwd?: string;
  changedPaths?: string[];
}) {
```

Add state for the toggle after existing state (line 19):
```tsx
const [changedOnly, setChangedOnly] = useState(false);
const changedSet = useMemo(
  () => new Set(changedPaths ?? []),
  [changedPaths]
);
```

Import `useMemo` in the imports.

- [ ] **Step 2: Add toggle UI**

Add the toggle checkbox next to the existing "Wrap lines" checkbox in the header (around line 69):

```tsx
<label className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 cursor-pointer select-none">
  <input
    type="checkbox"
    checked={wrapLines}
    onChange={(e) => setWrapLines(e.target.checked)}
    className="accent-blue-500"
  />
  Wrap lines
</label>
{changedPaths && changedPaths.length > 0 && (
  <label className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 cursor-pointer select-none ml-3">
    <input
      type="checkbox"
      checked={changedOnly}
      onChange={(e) => setChangedOnly(e.target.checked)}
      className="accent-blue-500"
    />
    Changed only
  </label>
)}
```

- [ ] **Step 3: Add tree filtering function**

Add a function to filter the tree to only include changed files and their parent directories:

```tsx
function filterTree(node: TreeNode, changedSet: Set<string>): TreeNode | null {
  if (!node.isDir) {
    return changedSet.has(node.path) ? node : null;
  }
  const filteredChildren = node.children
    ?.map((child) => filterTree(child, changedSet))
    .filter((child): child is TreeNode => child !== null);
  if (!filteredChildren || filteredChildren.length === 0) return null;
  return { ...node, children: filteredChildren };
}
```

- [ ] **Step 4: Apply filter to tree rendering**

In the tree rendering section (around line 87-98), apply the filter:

```tsx
{tree ? (
  <div className="py-1">
    {(changedOnly && changedSet.size > 0
      ? filterTree(tree, changedSet)?.children ?? []
      : tree.children ?? []
    ).map((node) => (
      <TreeItem
        key={node.path || node.name}
        node={node}
        depth={0}
        selectedPath={selectedPath}
        onSelect={openFile}
      />
    ))}
  </div>
) : (
  <div className="text-gray-500 text-xs p-3">Loading...</div>
)}
```

- [ ] **Step 5: Pass changedPaths from SessionPanel**

In `frontend/src/SessionPanel.tsx`, update the FileExplorer usage (around line 786):

```tsx
<FileExplorer
  requestedPath={fileToOpen}
  onSendInput={sendInputToTerminal}
  cwd={effectiveDir || undefined}
  changedPaths={diffFiles.map(f => f.path)}
/>
```

- [ ] **Step 6: Verify build**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel/frontend && npx tsc -b`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/FileExplorer.tsx frontend/src/SessionPanel.tsx
git commit -m "Add 'Changed only' toggle to Files tab"
```

---

### Task 3: Markdown viewer in Files tab (Issue #11)

**Problem:** `.md` files are shown as raw text in the Files tab. They should be rendered as formatted markdown with a toggle to switch to raw view.

**Approach:** In FileExplorer, detect `.md` extension and render with react-markdown (already a dependency) instead of HighlightedCode. Add a toggle button to switch between rendered and raw views.

**Files:**
- Modify: `frontend/src/components/FileExplorer.tsx`

- [ ] **Step 1: Add imports and state for markdown rendering**

Add imports at the top of FileExplorer.tsx:

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
```

Add a state variable for raw/rendered toggle in the FileExplorer component, after `wrapLines`:

```tsx
const [renderMarkdown, setRenderMarkdown] = useState(true);
```

- [ ] **Step 2: Add helper to detect markdown files**

```tsx
function isMarkdownFile(path: string): boolean {
  return /\.md$/i.test(path);
}
```

- [ ] **Step 3: Add rendered markdown component**

Add a `RenderedMarkdown` component:

```tsx
function RenderedMarkdown({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none p-4
      prose-headings:text-gray-100 prose-headings:mt-3 prose-headings:mb-1
      prose-p:text-gray-200 prose-p:leading-relaxed prose-p:my-1
      prose-li:text-gray-200 prose-li:my-0
      prose-code:text-blue-300 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
      prose-pre:bg-gray-900 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded-lg prose-pre:my-2
      prose-a:text-blue-400
      prose-strong:text-gray-100
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 4: Update file viewer to render markdown**

In the file viewer section (around line 120-128), add markdown rendering:

Replace the content area to conditionally render markdown:

```tsx
{isBinary ? (
  <div className="text-gray-500 text-sm p-4 flex items-center justify-center h-full">
    Binary file
  </div>
) : isMarkdownFile(selectedPath) && renderMarkdown ? (
  <RenderedMarkdown content={fileContent ?? ""} />
) : (
  <HighlightedCode content={fileContent ?? ""} path={selectedPath} onSendInput={onSendInput} wrapLines={wrapLines} />
)}
```

- [ ] **Step 5: Add raw/rendered toggle for markdown files**

In the file header bar (around line 117-118), add a toggle when viewing markdown:

```tsx
<div className="flex-shrink-0 px-3 py-1.5 text-xs text-gray-400 border-b border-gray-700 bg-gray-900/50 flex items-center">
  <span className="truncate">{selectedPath}</span>
  {isMarkdownFile(selectedPath) && (
    <button
      onClick={() => setRenderMarkdown(!renderMarkdown)}
      className="ml-auto text-xs text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded border border-gray-700 hover:border-gray-600"
    >
      {renderMarkdown ? "Raw" : "Preview"}
    </button>
  )}
</div>
```

- [ ] **Step 6: Verify build**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel/frontend && npx tsc -b`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/FileExplorer.tsx
git commit -m "Add markdown rendering in Files tab with raw/preview toggle"
```

---

### Task 4: Mermaid in markdown support (Issue #4)

**Problem:** Mermaid diagrams in markdown (```mermaid code blocks) are not rendered visually. They should render as SVG diagrams in both the conversation tab and the Files tab markdown viewer.

**Approach:** Install the `mermaid` package. Create a shared `MermaidBlock` component. Add a custom `code` component to ReactMarkdown that detects `language-mermaid` class and renders using mermaid.

**Files:**
- Create: `frontend/src/components/MermaidBlock.tsx`
- Modify: `frontend/src/SessionPanel.tsx` (conversation tab markdown)
- Modify: `frontend/src/components/FileExplorer.tsx` (files tab markdown)

- [ ] **Step 1: Install mermaid**

```bash
cd /Users/r-arai/src/github.com/ryotarai/oriel/frontend && npm install mermaid
```

- [ ] **Step 2: Create MermaidBlock component**

Create `frontend/src/components/MermaidBlock.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "loose",
});

let mermaidCounter = 0;

export function MermaidBlock({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const id = `mermaid-${++mermaidCounter}`;
    mermaid
      .render(id, chart)
      .then(({ svg }) => {
        setSvg(svg);
        setError("");
      })
      .catch((err) => {
        setError(String(err));
        setSvg("");
      });
  }, [chart]);

  if (error) {
    return <pre className="text-red-400 text-xs p-2">{error}</pre>;
  }

  return (
    <div
      ref={containerRef}
      className="my-2 flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
```

- [ ] **Step 3: Add mermaid rendering to conversation tab**

In `frontend/src/SessionPanel.tsx`, import MermaidBlock:

```tsx
import { MermaidBlock } from "./components/MermaidBlock";
```

In the ReactMarkdown `components` prop, update the `code` component to detect mermaid:

The existing `code` handler checks `className` for language classes. Add mermaid detection at the top:

```tsx
code: ({ children, className, ...props }) => {
  // Render mermaid diagrams
  if (className === "language-mermaid") {
    const chart = typeof children === "string" ? children : String(children ?? "");
    return <MermaidBlock chart={chart.trim()} />;
  }
  // For code blocks (has language class), use default rendering
  if (className) {
    return <code className={className} {...props}>{children}</code>;
  }
  // ... rest of existing inline code handling
```

- [ ] **Step 4: Add mermaid rendering to Files tab markdown viewer**

In `frontend/src/components/FileExplorer.tsx`, import MermaidBlock and add to the RenderedMarkdown component:

```tsx
import { MermaidBlock } from "./MermaidBlock";
```

Update RenderedMarkdown to include custom code component:

```tsx
function RenderedMarkdown({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none p-4 ...">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code: ({ children, className, ...props }) => {
            if (className === "language-mermaid") {
              const chart = typeof children === "string" ? children : String(children ?? "");
              return <MermaidBlock chart={chart.trim()} />;
            }
            return <code className={className} {...props}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 5: Verify build**

Run: `cd /Users/r-arai/src/github.com/ryotarai/oriel/frontend && npx tsc -b`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/MermaidBlock.tsx frontend/src/SessionPanel.tsx frontend/src/components/FileExplorer.tsx frontend/package.json frontend/package-lock.json
git commit -m "Add Mermaid diagram rendering in conversation and Files tabs"
```
