import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

interface InputAreaProps {
  onKeyData: (data: string) => void;
  /** The input-prompt, separator, and status-bar blocks from the bottom of the screen */
  bottomBlocks: Block[];
}

export function InputArea({ onKeyData, bottomBlocks }: InputAreaProps) {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 p-2 focus:outline-none"
      tabIndex={0}
      onKeyDown={(e) => {
        e.preventDefault();
        const data = keyEventToData(e);
        if (data) onKeyData(data);
      }}
      // Auto-focus on mount
      ref={(el) => el?.focus()}
    >
      {bottomBlocks.length > 0 ? (
        <div className="font-mono text-sm">
          {bottomBlocks.map((block, i) => (
            <TerminalFallback key={i} lines={block.lines} />
          ))}
        </div>
      ) : (
        <div className="text-gray-400 text-sm text-center py-1">
          Type here — keystrokes are forwarded to Claude Code
        </div>
      )}
    </div>
  );
}

function keyEventToData(e: React.KeyboardEvent): string | null {
  if (e.key === "Enter") return "\r";
  if (e.key === "Backspace") return "\x7f";
  if (e.key === "Tab") return "\t";
  if (e.key === "Escape") return "\x1b";
  if (e.key === "ArrowUp") return "\x1b[A";
  if (e.key === "ArrowDown") return "\x1b[B";
  if (e.key === "ArrowRight") return "\x1b[C";
  if (e.key === "ArrowLeft") return "\x1b[D";

  if (e.ctrlKey && e.key.length === 1) {
    const code = e.key.toLowerCase().charCodeAt(0) - 96;
    if (code > 0 && code < 27) return String.fromCharCode(code);
    return null;
  }

  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return e.key;
  }

  return null;
}
