import { useRef, useEffect, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const WS_URL = `ws://${window.location.host}/ws`;

interface ConversationEntry {
  type: string;
  role: string;
  uuid: string;
  text: string;
  isThinking?: boolean;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const seenUUIDs = useRef(new Set<string>());
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Split position: percentage of viewport height for chat panel
  const [splitPct, setSplitPct] = useState(70);
  const dragging = useRef(false);

  const handleConversation = useCallback((entry: ConversationEntry) => {
    if (seenUUIDs.current.has(entry.uuid)) return;
    seenUUIDs.current.add(entry.uuid);
    if (entry.isThinking) return;
    setEntries((prev) => [...prev, entry]);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#0a0a0f",
        foreground: "#e4e4e7",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    fitRef.current = fit;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      sendResize(ws, term.cols, term.rows);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        term.write(bytes);
      } else if (msg.type === "conversation" && msg.entry) {
        const entry = typeof msg.entry === "string" ? JSON.parse(msg.entry) : msg.entry;
        handleConversation(entry);
      }
    };

    ws.onclose = () => setConnected(false);

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const bytes = new TextEncoder().encode(data);
        const base64 = btoa(String.fromCharCode(...bytes));
        ws.send(JSON.stringify({ type: "input", data: base64 }));
      }
    });

    const onResize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        sendResize(ws, term.cols, term.rows);
      }
    };

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        sendResize(ws, cols, rows);
      }
    });

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
    };
  }, [handleConversation]);

  // Re-fit terminal when split changes
  useEffect(() => {
    const id = setTimeout(() => fitRef.current?.fit(), 50);
    return () => clearTimeout(id);
  }, [splitPct]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  // Drag handling
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const pct = (ev.clientY / window.innerHeight) * 100;
      setSplitPct(Math.max(10, Math.min(90, pct)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Re-fit after drag ends
      setTimeout(() => fitRef.current?.fit(), 50);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div className="h-screen w-screen bg-[#0a0a0f] flex flex-col overflow-hidden">
      {/* Chat panel (top) */}
      <div style={{ height: `${splitPct}%` }} className="flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!connected && (
            <div className="text-center text-yellow-400 text-sm">Connecting...</div>
          )}
          {entries.length === 0 && connected && (
            <div className="text-gray-600 text-sm text-center mt-8">
              Messages will appear here...
            </div>
          )}
          {entries.map((entry) => (
            <MessageBubble key={entry.uuid} entry={entry} />
          ))}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className="h-1.5 bg-gray-800 hover:bg-blue-600 cursor-row-resize flex-shrink-0 transition-colors"
      />

      {/* Terminal (bottom) */}
      <div style={{ height: `${100 - splitPct}%` }} className="min-h-0">
        <div ref={containerRef} className="h-full" />
      </div>
    </div>
  );
}

function MessageBubble({ entry }: { entry: ConversationEntry }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-blue-900/40 border border-blue-800/50 px-4 py-2 text-gray-100 text-sm whitespace-pre-wrap">
          {entry.text}
        </div>
      </div>
    );
  }

  return (
    <div className="prose prose-invert prose-sm max-w-none
      prose-headings:text-gray-100 prose-headings:mt-3 prose-headings:mb-1
      prose-p:text-gray-200 prose-p:leading-relaxed prose-p:my-1
      prose-li:text-gray-200 prose-li:my-0
      prose-code:text-blue-300 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
      prose-pre:bg-gray-900 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded-lg prose-pre:my-2
      prose-a:text-blue-400
      prose-strong:text-gray-100
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {entry.text}
      </ReactMarkdown>
    </div>
  );
}

function sendResize(ws: WebSocket, cols: number, rows: number) {
  ws.send(JSON.stringify({ type: "resize", cols, rows }));
}
