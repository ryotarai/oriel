# Conversation Tab UI Improvements

## Overview

Four UI improvements to the conversation tab in Oriel's SessionPanel.

## 1. Agent Result Box + Accordion

**Goal:** Display Agent tool results in a distinct box (like plan results) with auto-collapse for tall content.

**Component:** `AgentResultBlock` (inline in SessionPanel.tsx)

**Design:**
- Box styling: `rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-2`
- Top-left label: "Agent" in green (`text-green-400 text-xs font-medium`)
- Content: markdown rendered via ReactMarkdown (reuse existing config)
- **Accordion:** Uses `useRef` + `useEffect` to measure rendered content height
  - If rendered height >= 200px: collapse to 200px with CSS gradient overlay (`linear-gradient(transparent, bg-gray-800/60)`) and "Show more" button
  - On expand: show full content + "Show less" button
  - If rendered height < 200px: show full content, no accordion

**Integration point:** Replace current agent result rendering in `MessageBubble` (lines ~745-767) with `AgentResultBlock`.

## 2. Table Overflow Fix

**Goal:** Prevent markdown tables from overflowing the conversation container.

**Implementation:**
- Add custom `table` renderer to ReactMarkdown `components` prop
- Wrap `<table>` in `<div className="overflow-x-auto max-w-full">`
- Apply to both assistant and user message ReactMarkdown instances

## 3. Local-Command-Stdout Display

**Goal:** Render `<local-command-stdout>...</local-command-stdout>` content in a styled monospace block.

**Implementation:**
- Add `parseLocalCommandStdout(text: string)` parser function
- Detection: regex match for `<local-command-stdout>(.*?)</local-command-stdout>` (with dotAll flag)
- Rendering: monospace block similar to BashBlock
  - `rounded-lg bg-gray-900 border border-gray-700/50 px-3 py-2 font-mono text-sm text-gray-300`
  - Small "Output" label in gray
- Integration: Add to MessageBubble's user message rendering pipeline, after existing slash command detection

## 4. Technical Notes

- All changes in `SessionPanel.tsx` (inline components, following existing patterns)
- Accordion height measurement via `ResizeObserver` for dynamic content
- No new dependencies required
