import { useRef, useState, useCallback } from "react";
import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

interface InputAreaProps {
  onKeyData: (data: string) => void;
  bottomBlocks: Block[];
}

export function InputArea({ onKeyData, bottomBlocks }: InputAreaProps) {
  const [value, setValue] = useState("");
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendText = useCallback(
    (text: string) => {
      // Send entire string at once (works for multibyte/IME input)
      onKeyData(text);
    },
    [onKeyData],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't intercept during IME composition
    if (composingRef.current || e.nativeEvent.isComposing) return;

    // Ctrl+key shortcuts — send as control characters
    if (e.ctrlKey && e.key.length === 1) {
      e.preventDefault();
      const code = e.key.toLowerCase().charCodeAt(0) - 96;
      if (code > 0 && code < 27) onKeyData(String.fromCharCode(code));
      return;
    }

    // Cmd+Enter (Mac) or Ctrl+Enter — send the text + carriage return
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (value.length > 0) {
        sendText(value);
      }
      onKeyData("\r");
      setValue("");
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      return;
    }

    // Plain Enter — let it add a newline (default behavior)
    if (e.key === "Enter") {
      return;
    }

    // Escape — send escape to pty and clear
    if (e.key === "Escape") {
      e.preventDefault();
      onKeyData("\x1b");
      setValue("");
      return;
    }

    // Tab — send tab character
    if (e.key === "Tab") {
      e.preventDefault();
      onKeyData("\t");
      return;
    }

    // Arrow keys — send to pty (for navigating Claude Code menus)
    if (e.key === "ArrowUp") {
      e.preventDefault();
      onKeyData("\x1b[A");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onKeyData("\x1b[B");
      return;
    }
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700">
      {bottomBlocks.length > 0 && (
        <div
          className="font-mono text-sm px-2 pt-2 cursor-text"
          onClick={() => textareaRef.current?.focus()}
        >
          {bottomBlocks.map((block, i) => (
            <TerminalFallback key={i} lines={block.lines} />
          ))}
        </div>
      )}
      <div className="px-2 pb-2 pt-1">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            // On some browsers, onChange fires before compositionEnd
            // so update value from the event
            setValue(e.currentTarget.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type here... (Cmd+Enter to send)"
          rows={1}
          className="w-full bg-gray-800 text-gray-100 rounded-lg px-3 py-2 text-sm resize-none border border-gray-700 focus:border-blue-600 focus:outline-none placeholder-gray-500"
          autoFocus
          onInput={(e) => {
            // Auto-resize textarea
            const target = e.currentTarget;
            target.style.height = "auto";
            target.style.height = Math.min(target.scrollHeight, 120) + "px";
          }}
        />
      </div>
    </div>
  );
}
