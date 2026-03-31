import { useRef, useEffect } from "react";
import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

interface InputAreaProps {
  onKeyData: (data: string) => void;
  bottomBlocks: Block[];
}

export function InputArea({ onKeyData, bottomBlocks }: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  // Keep the textarea focused
  useEffect(() => {
    const focus = () => {
      // Small delay to let click events settle
      setTimeout(() => textareaRef.current?.focus(), 0);
    };
    focus();
    document.addEventListener("click", focus);
    return () => document.removeEventListener("click", focus);
  }, []);

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 min-h-[5rem]">
      {/* Pty prompt display — fixed height to prevent layout jumps */}
      <div className="font-mono text-sm px-2 pt-2 min-h-[3rem]">
        {bottomBlocks.map((block, i) => (
          <TerminalFallback key={i} lines={block.lines} />
        ))}
      </div>

      {/* IME-capable input: visually minimal but functional for IME */}
      <div className="px-2 pb-2 pt-1">
        <textarea
          ref={textareaRef}
          rows={1}
          autoFocus
          className="w-full bg-gray-800/50 text-gray-100 text-sm rounded px-2 py-1
                     border border-gray-700/50 focus:border-gray-600 focus:outline-none
                     resize-none placeholder-gray-600 caret-gray-400 overflow-hidden"
          style={{ maxHeight: "6rem" }}
          placeholder="Type message — Cmd+Enter to send"
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            const text = e.currentTarget.value;
            if (text) {
              onKeyData(text);
              e.currentTarget.value = "";
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text");
            if (text) onKeyData(text);
          }}
          onInput={(e) => {
            // During IME composition, let text accumulate in textarea.
            if (composingRef.current) {
              return;
            }
            // Auto-resize textarea height
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = el.scrollHeight + "px";
          }}
          onKeyDown={(e) => {
            // Skip IME-initiated keystrokes (keyCode 229 = IME processing)
            if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;

            // Cmd+Enter (or Ctrl+Enter) → send (submit the textarea content then \r)
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              const text = textareaRef.current?.value ?? "";
              if (text) onKeyData(text);
              onKeyData("\r");
              if (textareaRef.current) textareaRef.current.value = "";
              return;
            }

            // Plain Enter → insert newline in textarea (default behavior, don't prevent)
            if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
              return;
            }

            const data = keyEventToData(e);
            if (data !== null) {
              e.preventDefault();
              onKeyData(data);
              // Clear any leftover text
              if (textareaRef.current) textareaRef.current.value = "";
            }
          }}
        />
      </div>
    </div>
  );
}

function keyEventToData(e: React.KeyboardEvent): string | null {
  if (e.key === "Backspace") return "\x7f";
  if (e.key === "Delete") return "\x1b[3~";
  if (e.key === "Tab" && e.shiftKey) return "\x1b[Z";
  if (e.key === "Tab") return "\t";
  if (e.key === "Escape") return "\x1b";
  if (e.key === "ArrowUp") return "\x1b[A";
  if (e.key === "ArrowDown") return "\x1b[B";
  if (e.key === "ArrowRight") return "\x1b[C";
  if (e.key === "ArrowLeft") return "\x1b[D";
  if (e.key === "Home") return "\x1b[H";
  if (e.key === "End") return "\x1b[F";

  // Ctrl+key
  if (e.ctrlKey && e.key.length === 1) {
    const code = e.key.toLowerCase().charCodeAt(0) - 96;
    if (code > 0 && code < 27) return String.fromCharCode(code);
    return null;
  }

  // Regular printable character — send directly to pty
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return e.key;
  }

  return null;
}
