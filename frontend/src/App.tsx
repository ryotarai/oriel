import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket, type ConversationEntry } from "./hooks/useWebSocket";
import { HiddenTerminal } from "./terminal/HiddenTerminal";
import { extractLines } from "./terminal/BufferReader";
import { detectBlocks } from "./terminal/PatternDetector";
import type { Block } from "./types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { WelcomeCard } from "./components/WelcomeCard";
import { ToolCallCard } from "./components/ToolCallCard";
import { DiffView } from "./components/DiffView";
import { SpinnerIndicator } from "./components/SpinnerIndicator";
import { StatusBar } from "./components/StatusBar";
import { TerminalFallback } from "./components/TerminalFallback";
import { InputArea } from "./components/InputArea";

const WS_URL = `ws://${window.location.host}/ws`;

/** Items displayed in the main content area */
type DisplayItem =
  | { kind: "pty-block"; block: Block; key: string }
  | { kind: "conversation"; entry: ConversationEntry; key: string };

export default function App() {
  const [ptyBlocks, setPtyBlocks] = useState<Block[]>([]);
  const [bottomBlocks, setBottomBlocks] = useState<Block[]>([]);
  const [convEntries, setConvEntries] = useState<ConversationEntry[]>([]);
  const [exited, setExited] = useState(false);
  const hiddenTermRef = useRef<HiddenTerminal | null>(null);
  const hiddenDivRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seenUUIDs = useRef(new Set<string>());

  useEffect(() => {
    if (hiddenDivRef.current && !hiddenTermRef.current) {
      const ht = new HiddenTerminal();
      ht.mount(hiddenDivRef.current);
      hiddenTermRef.current = ht;
    }
    return () => {
      hiddenTermRef.current?.dispose();
      hiddenTermRef.current = null;
    };
  }, []);

  const prevBottomRef = useRef<Block[]>([]);

  const updateBlocks = useCallback(() => {
    const ht = hiddenTermRef.current;
    if (!ht) return;
    const lines = extractLines(ht.terminal.buffer.active as any);

    // Split lines into main content and bottom input area.
    // The bottom area in Claude Code's terminal is always the last few lines:
    // separator (────) + input prompt (❯) + separator (────) + status bar (⏵⏵)
    // We search from the end for the first separator that starts the bottom area.
    let bottomStartLine = lines.length;
    for (let j = lines.length - 1; j >= Math.max(0, lines.length - 8); j--) {
      const text = lines[j].text.trim();
      if (/^─+$/.test(text) && lines[j].spans.some(s => s.fg === 244)) {
        bottomStartLine = j;
      } else if (bottomStartLine < lines.length) {
        break;
      }
    }

    const mainLines = lines.slice(0, bottomStartLine);
    const bottomLines = lines.slice(bottomStartLine);

    const detected = detectBlocks(mainLines);
    const bottomDetected = detectBlocks(bottomLines);

    setPtyBlocks(detected);

    // Only update bottom blocks if we found a valid bottom area.
    // During redraws the bottom may temporarily disappear — keep the previous one.
    if (bottomDetected.length > 0) {
      prevBottomRef.current = bottomDetected;
      setBottomBlocks(bottomDetected);
    }
    // else: keep previous bottomBlocks unchanged
  }, []);

  const handleConversation = useCallback((entry: ConversationEntry) => {
    if (seenUUIDs.current.has(entry.uuid)) return;
    seenUUIDs.current.add(entry.uuid);
    if (entry.isThinking) return; // skip thinking blocks
    setConvEntries((prev) => [...prev, entry]);
  }, []);

  const { connected, sendInput } = useWebSocket({
    url: WS_URL,
    onOutput: (data) => {
      hiddenTermRef.current?.write(data);
      requestAnimationFrame(updateBlocks);
    },
    onExit: () => setExited(true),
    onConversation: handleConversation,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [ptyBlocks, convEntries]);

  // Build display items: use conversation entries for user/assistant text,
  // pty blocks for everything else (welcome, tool calls, diffs, spinners)
  const displayItems = buildDisplayItems(ptyBlocks, convEntries);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <div ref={hiddenDivRef} className="absolute -left-[9999px] w-0 h-0 overflow-hidden" />

      {!connected && !exited && (
        <div className="p-4 text-center text-yellow-400">Connecting...</div>
      )}
      {exited && (
        <div className="p-4 text-center text-red-400">
          Session ended.{" "}
          <button onClick={() => window.location.reload()} className="underline hover:text-red-300">
            Restart
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto pb-24">
        {displayItems.map((item) => {
          if (item.kind === "conversation") {
            return <ConversationMessage key={item.key} entry={item.entry} />;
          }
          return <PtyBlockRenderer key={item.key} block={item.block} />;
        })}
      </div>

      <InputArea onKeyData={sendInput} bottomBlocks={bottomBlocks} />
    </div>
  );
}

function buildDisplayItems(ptyBlocks: Block[], convEntries: ConversationEntry[]): DisplayItem[] {
  const items: DisplayItem[] = [];

  if (convEntries.length > 0) {
    // When we have conversation entries, only show welcome from pty
    // and use conversation entries for all user/assistant content
    for (const block of ptyBlocks) {
      if (block.type === "welcome") {
        items.push({ kind: "pty-block", block, key: `pty-welcome` });
        break;
      }
    }

    // Show conversation entries (with proper markdown)
    for (const entry of convEntries) {
      items.push({ kind: "conversation", entry, key: `conv-${entry.uuid}` });
    }
  } else {
    // No conversation entries yet — fall back to pty-only rendering
    for (let i = 0; i < ptyBlocks.length; i++) {
      items.push({ kind: "pty-block", block: ptyBlocks[i], key: `pty-${i}` });
    }
  }

  return items;
}

function ConversationMessage({ entry }: { entry: ConversationEntry }) {
  if (entry.role === "user") {
    return (
      <div className="my-3 flex justify-end px-4">
        <div className="max-w-2xl rounded-2xl bg-blue-900/40 border border-blue-800/50 px-4 py-2 text-gray-100">
          {entry.text}
        </div>
      </div>
    );
  }

  // Assistant message — render as markdown
  return (
    <div className="my-3 px-4 prose prose-invert prose-sm max-w-none
      prose-headings:text-gray-100 prose-headings:mt-4 prose-headings:mb-2
      prose-p:text-gray-200 prose-p:leading-relaxed
      prose-li:text-gray-200
      prose-code:text-blue-300 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded
      prose-pre:bg-gray-900 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded-lg
      prose-a:text-blue-400
      prose-strong:text-gray-100
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {entry.text}
      </ReactMarkdown>
    </div>
  );
}

function PtyBlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case "welcome": return <WelcomeCard block={block} />;
    case "user-prompt": return (
      <div className="my-3 flex justify-end px-4">
        <div className="max-w-2xl rounded-2xl bg-blue-900/40 border border-blue-800/50 px-4 py-2 text-gray-100">
          {block.lines[0]?.text.replace(/^❯\s*/, "").trim()}
        </div>
      </div>
    );
    case "assistant-text": return (
      <div className="my-1 px-4 text-gray-200 leading-relaxed">
        {block.content ?? block.lines.map(l => l.text.trim()).join(" ")}
      </div>
    );
    case "heading": return <Heading block={block} />;
    case "bullet-list": return <BulletList block={block} />;
    case "code-block": return (
      <div className="my-3 mx-4 rounded-lg border border-gray-700 bg-gray-900 overflow-x-auto">
        <div className="p-4"><TerminalFallback lines={block.lines} /></div>
      </div>
    );
    case "tool-call": return <ToolCallCard block={block} />;
    case "tool-result": return null;
    case "diff": return <DiffView block={block} />;
    case "spinner": return <SpinnerIndicator block={block} />;
    case "separator": return <div className="my-2 border-t border-gray-800" />;
    case "status-bar": return <StatusBar block={block} />;
    case "input-prompt": return <TerminalFallback lines={block.lines} />;
    default: return <TerminalFallback lines={block.lines} />;
  }
}

function Heading({ block }: { block: Block }) {
  const level = (block.meta?.level as number) ?? 2;
  const text = block.content ?? block.lines[0]?.text ?? "";
  if (level === 1) {
    return <h2 className="text-xl font-bold text-gray-100 mt-4 mb-2 px-4">{text}</h2>;
  }
  return <h3 className="text-lg font-semibold text-gray-200 mt-3 mb-1 px-4">{text}</h3>;
}

function BulletList({ block }: { block: Block }) {
  const items: string[] = [];
  let current = "";
  for (const line of block.lines) {
    const text = line.text.trim();
    if (text === "") continue;
    if (text.startsWith("- ")) {
      if (current) items.push(current);
      current = text.slice(2);
    } else {
      current += " " + text;
    }
  }
  if (current) items.push(current);

  return (
    <ul className="my-1 px-4 list-disc list-inside space-y-1 text-gray-200">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}
