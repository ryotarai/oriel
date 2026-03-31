import type { ScreenLine, Block } from "../types";

/**
 * Detects semantic blocks from raw ScreenLine[] data captured from
 * a Claude Code terminal session.
 */
export function detectBlocks(lines: ScreenLine[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines (they belong to spacing between blocks)
    if (isEmptyLine(line)) {
      i++;
      continue;
    }

    // Welcome box: starts with ╭ and fg=174
    if (isWelcomeBoxStart(line)) {
      const start = i;
      while (i < lines.length && !isWelcomeBoxEnd(lines[i])) {
        i++;
      }
      if (i < lines.length) i++; // include the ╰ line
      blocks.push({
        type: "welcome",
        lines: lines.slice(start, i),
      });
      continue;
    }

    // User prompt: ❯ with bg=237
    if (isUserPrompt(line)) {
      blocks.push({
        type: "user-prompt",
        lines: [line],
      });
      i++;
      continue;
    }

    // Separator: line of ─ characters with fg=244
    if (isSeparator(line)) {
      blocks.push({
        type: "separator",
        lines: [line],
      });
      i++;
      continue;
    }

    // Input prompt: ❯ without bg=237 (the bottom input area)
    if (isInputPrompt(line)) {
      blocks.push({
        type: "input-prompt",
        lines: [line],
      });
      i++;
      continue;
    }

    // Tool call: ● with fg=114 (green)
    if (isToolCall(line)) {
      blocks.push({
        type: "tool-call",
        lines: [line],
      });
      i++;
      continue;
    }

    // Tool result: line starting with ⎿ (fg=246)
    if (isToolResult(line)) {
      const start = i;
      i++;
      // Collect continuation lines that belong to the tool result
      // (lines after ⎿ that are not a new block start, including diff lines and content lines)
      while (i < lines.length) {
        const nextLine = lines[i];
        if (isEmptyLine(nextLine)) break;
        if (isToolCall(nextLine)) break;
        if (isAssistantResponseStart(nextLine)) break;
        if (isUserPrompt(nextLine)) break;
        if (isSeparator(nextLine)) break;
        if (isInputPrompt(nextLine)) break;
        if (isToolResult(nextLine)) {
          // Another ⎿ line is still part of this tool result
          i++;
          continue;
        }
        i++;
      }
      const resultLines = lines.slice(start, i);
      // Check if this tool result contains diff lines
      const hasDiff = resultLines.some((l) => isDiffLine(l));
      if (hasDiff) {
        // Split into tool-result and diff blocks
        const toolResultLines: ScreenLine[] = [];
        const diffLines: ScreenLine[] = [];
        let inDiff = false;
        for (const rl of resultLines) {
          if (isDiffLine(rl)) {
            inDiff = true;
            diffLines.push(rl);
          } else {
            if (inDiff) {
              // Non-diff line after diff lines; this shouldn't normally happen
              // but handle gracefully
              toolResultLines.push(rl);
            } else {
              toolResultLines.push(rl);
            }
          }
        }
        if (toolResultLines.length > 0) {
          blocks.push({
            type: "tool-result",
            lines: toolResultLines,
          });
        }
        if (diffLines.length > 0) {
          blocks.push({
            type: "diff",
            lines: diffLines,
          });
        }
      } else {
        blocks.push({
          type: "tool-result",
          lines: resultLines,
        });
      }
      continue;
    }

    // Diff line standalone (non-default bg, not bg=237)
    if (isDiffLine(line)) {
      const start = i;
      while (i < lines.length && isDiffLine(lines[i])) {
        i++;
      }
      blocks.push({
        type: "diff",
        lines: lines.slice(start, i),
      });
      continue;
    }

    // Assistant response: ● with fg=231
    if (isAssistantResponseStart(line)) {
      const start = i;
      i++;
      // Collect lines until next block-level marker
      while (i < lines.length) {
        const nextLine = lines[i];
        if (isUserPrompt(nextLine)) break;
        if (isSeparator(nextLine)) break;
        if (isToolCall(nextLine)) break;
        if (isToolResult(nextLine)) break;
        if (isInputPrompt(nextLine)) break;
        if (isWelcomeBoxStart(nextLine)) break;
        if (isAssistantResponseStart(nextLine)) break;
        if (isDiffLine(nextLine)) break;
        i++;
      }
      const responseLines = lines.slice(start, i);

      // Sub-detect within assistant response
      const subBlocks = subDetectAssistantContent(responseLines);
      blocks.push(...subBlocks);
      continue;
    }

    // Status bar: contains ⏵⏵
    if (line.text.includes("⏵⏵")) {
      blocks.push({
        type: "status-bar",
        lines: [line],
      });
      i++;
      continue;
    }

    // Collapsed tool info (e.g., "Read 1 file(ctrl+o to expand)")
    // These lines have fg=246 spans and contain tool-related info
    if (isCollapsedToolInfo(line)) {
      blocks.push({
        type: "tool-result",
        lines: [line],
      });
      i++;
      continue;
    }

    // Unknown / fallback
    blocks.push({
      type: "unknown",
      lines: [line],
    });
    i++;
  }

  return blocks;
}

// --- Helper predicates ---

function isEmptyLine(line: ScreenLine): boolean {
  return line.text.trim() === "";
}

function isWelcomeBoxStart(line: ScreenLine): boolean {
  return (
    line.text.trimStart().startsWith("╭") &&
    line.spans.some((s) => s.fg === 174)
  );
}

function isWelcomeBoxEnd(line: ScreenLine): boolean {
  return (
    line.text.trimStart().startsWith("╰") &&
    line.spans.some((s) => s.fg === 174)
  );
}

function isUserPrompt(line: ScreenLine): boolean {
  // ❯ with bg=237 on the first span
  const firstNonEmpty = line.spans.find((s) => s.text.trim().length > 0);
  if (!firstNonEmpty) return false;
  return firstNonEmpty.text.startsWith("❯") && firstNonEmpty.bg === 237;
}

function isSeparator(line: ScreenLine): boolean {
  const trimmed = line.text.trim();
  if (trimmed.length < 10) return false;
  // All characters are ─
  if (!/^[─]+$/.test(trimmed)) return false;
  return line.spans.some((s) => s.fg === 244 && s.text.includes("─"));
}

function isInputPrompt(line: ScreenLine): boolean {
  const trimmed = line.text.trim();
  if (!trimmed.startsWith("❯")) return false;
  // Input prompt does NOT have bg=237
  const firstNonEmpty = line.spans.find((s) => s.text.trim().length > 0);
  if (!firstNonEmpty) return false;
  return firstNonEmpty.bg !== 237;
}

function isToolCall(line: ScreenLine): boolean {
  // ● with fg=114 (green)
  const firstNonEmpty = line.spans.find((s) => s.text.trim().length > 0);
  if (!firstNonEmpty) return false;
  return firstNonEmpty.text.includes("●") && firstNonEmpty.fg === 114;
}

function isToolResult(line: ScreenLine): boolean {
  // Lines containing ⎿ with fg=246
  return line.spans.some(
    (s) => s.text.includes("⎿") && s.fg === 246
  );
}

function isAssistantResponseStart(line: ScreenLine): boolean {
  // ● with fg=231 (white)
  const firstNonEmpty = line.spans.find((s) => s.text.trim().length > 0);
  if (!firstNonEmpty) return false;
  return firstNonEmpty.text.includes("●") && firstNonEmpty.fg === 231;
}

function isDiffLine(line: ScreenLine): boolean {
  // Lines with non-default bg colors that indicate diff add/remove
  // These have large RGB-encoded bg values (not 237, not 16, not null)
  return line.spans.some((s) => {
    if (s.bg === null || s.bg === 237 || s.bg === 16) return false;
    // Large bg values are true-color RGB values used for diff highlighting
    return s.bg > 255;
  });
}

function isCollapsedToolInfo(line: ScreenLine): boolean {
  // Lines like "Read 1 file(ctrl+o to expand)" with fg=246 spans
  const hasToolKeyword = line.spans.some(
    (s) =>
      s.fg === 246 &&
      (s.text.includes("Read") ||
        s.text.includes("Write") ||
        s.text.includes("Edit"))
  );
  return hasToolKeyword && line.text.includes("file");
}

// --- Sub-detection within assistant response blocks ---

function subDetectAssistantContent(lines: ScreenLine[]): Block[] {
  // Always try sub-detection — even responses without H1 headings
  // can contain bullets, code blocks, H2 headings, etc.
  if (lines.length > 1) {
    const subBlocks = detectSubBlocks(lines);
    if (subBlocks.length > 0) return subBlocks;
  }

  // Single-line or no sub-structure detected
  return [{ type: "assistant-text", lines }];
}

function detectSubBlocks(lines: ScreenLine[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // H1: The first line with ● and bold+italic+underline span
    if (
      isAssistantResponseStart(line) &&
      line.spans.some(
        (s) => s.bold && s.italic && s.underline && s.text.trim().length > 0
      )
    ) {
      blocks.push({ type: "heading", lines: [line], meta: { level: 1 } });
      i++;
      continue;
    }

    // Assistant response start line (● fg=231) without H1 formatting
    if (isAssistantResponseStart(line)) {
      blocks.push({ type: "assistant-text", lines: [line] });
      i++;
      continue;
    }

    // H2: bold text at line start (not a bullet)
    if (isH2Heading(line)) {
      blocks.push({ type: "heading", lines: [line], meta: { level: 2 } });
      i++;
      continue;
    }

    // Bullet list: lines starting with "  - "
    if (isBulletLine(line)) {
      const start = i;
      i++;
      // Collect continuation lines (not starting with "  - " but indented)
      while (i < lines.length) {
        if (isBulletLine(lines[i])) {
          i++;
          continue;
        }
        // Continuation of previous bullet (indented text, no other markers)
        if (isBulletContinuation(lines[i])) {
          i++;
          continue;
        }
        break;
      }
      blocks.push({
        type: "bullet-list",
        lines: lines.slice(start, i),
      });
      continue;
    }

    // Code block: lines with syntax-highlight colors (fg=1,2,3,4)
    if (isCodeLine(line)) {
      const start = i;
      while (i < lines.length && (isCodeLine(lines[i]) || isEmptyLine(lines[i]))) {
        // Don't include trailing empty lines that might belong to next block
        if (isEmptyLine(lines[i])) {
          // Look ahead: if next non-empty line is still code, include the blank
          let j = i + 1;
          while (j < lines.length && isEmptyLine(lines[j])) j++;
          if (j < lines.length && isCodeLine(lines[j])) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      blocks.push({
        type: "code-block",
        lines: lines.slice(start, i),
      });
      continue;
    }

    // Empty lines
    if (isEmptyLine(line)) {
      i++;
      continue;
    }

    // Regular assistant text
    {
      const start = i;
      i++;
      while (i < lines.length) {
        if (
          isH2Heading(lines[i]) ||
          isBulletLine(lines[i]) ||
          isCodeLine(lines[i]) ||
          isEmptyLine(lines[i])
        ) {
          break;
        }
        i++;
      }
      blocks.push({
        type: "assistant-text",
        lines: lines.slice(start, i),
      });
    }
  }

  return blocks;
}

function isH2Heading(line: ScreenLine): boolean {
  // Bold text at line start that is not a bullet
  const trimmed = line.text.trim();
  if (trimmed.startsWith("- ") || trimmed.startsWith("● ")) return false;
  if (trimmed.length === 0) return false;

  // Find first meaningful span (skip leading whitespace spans)
  const meaningfulSpans = line.spans.filter((s) => s.text.trim().length > 0);
  if (meaningfulSpans.length === 0) return false;

  const first = meaningfulSpans[0];
  // The heading span should be bold, not italic, not underline
  if (!first.bold || first.italic || first.underline) return false;

  // Must be followed by non-bold trailing whitespace (typical heading pattern)
  // or be the only meaningful content
  if (meaningfulSpans.length === 1 && first.bold) return true;

  // H2 has the bold span as the main content
  return first.bold && first.text.trim().length > 3;
}

function isBulletLine(line: ScreenLine): boolean {
  return /^\s{1,4}-\s/.test(line.text);
}

function isBulletContinuation(line: ScreenLine): boolean {
  // Indented continuation (3+ spaces, not a bullet, not a heading)
  const trimmed = line.text.trim();
  if (trimmed.length === 0) return false;
  if (/^\s{3,}/.test(line.text) && !line.text.trimStart().startsWith("- ")) {
    // Not a heading or code line
    return !isH2Heading(line) && !isCodeLine(line);
  }
  return false;
}

function isCodeLine(line: ScreenLine): boolean {
  // Code lines have syntax-highlight colors: fg=1 (red/strings), fg=2 (green/numbers),
  // fg=3 (yellow/identifiers), fg=4 (blue/keywords)
  return line.spans.some(
    (s) =>
      s.text.trim().length > 0 &&
      (s.fg === 1 || s.fg === 2 || s.fg === 3 || s.fg === 4)
  );
}
