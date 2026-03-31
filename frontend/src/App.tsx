// frontend/src/App.tsx
import { useState, useCallback, useRef, useEffect } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { HiddenTerminal } from "./terminal/HiddenTerminal";
import { extractLines } from "./terminal/BufferReader";
import { detectBlocks } from "./terminal/PatternDetector";
import type { Block } from "./types";

import { WelcomeCard } from "./components/WelcomeCard";
import { UserMessage } from "./components/UserMessage";
import { AssistantMessage } from "./components/AssistantMessage";
import { CodeBlock } from "./components/CodeBlock";
import { ToolCallCard } from "./components/ToolCallCard";
import { DiffView } from "./components/DiffView";
import { SpinnerIndicator } from "./components/SpinnerIndicator";
import { StatusBar } from "./components/StatusBar";
import { TerminalFallback } from "./components/TerminalFallback";
import { InputArea } from "./components/InputArea";

const WS_URL = `ws://${window.location.host}/ws`;

export default function App() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [exited, setExited] = useState(false);
  const hiddenTermRef = useRef<HiddenTerminal | null>(null);
  const hiddenDivRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  const updateBlocks = useCallback(() => {
    const ht = hiddenTermRef.current;
    if (!ht) return;
    const lines = extractLines(ht.terminal.buffer.active as any);
    const detected = detectBlocks(lines);
    setBlocks(detected);
  }, []);

  const { connected, sendInput } = useWebSocket({
    url: WS_URL,
    onOutput: (data) => {
      hiddenTermRef.current?.write(data);
      requestAnimationFrame(updateBlocks);
    },
    onExit: () => setExited(true),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks]);

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
        {blocks.map((block, i) => (
          <BlockRenderer key={`${block.type}-${i}`} block={block} />
        ))}
      </div>

      <InputArea onKeyData={sendInput} />
    </div>
  );
}

function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case "welcome": return <WelcomeCard block={block} />;
    case "user-prompt": return <UserMessage block={block} />;
    case "assistant-text": return <AssistantMessage block={block} />;
    case "heading": return <Heading block={block} />;
    case "bullet-list": return <BulletList block={block} />;
    case "code-block": return <CodeBlock block={block} />;
    case "tool-call": return <ToolCallCard block={block} />;
    case "tool-result": return null;
    case "diff": return <DiffView block={block} />;
    case "spinner": return <SpinnerIndicator block={block} />;
    case "separator": return <div className="my-2 border-t border-gray-800" />;
    case "status-bar": return <StatusBar block={block} />;
    case "input-prompt": return null;
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
