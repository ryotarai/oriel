import { useRef, useEffect, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ConversationEntry {
  type: string;
  role: string;
  uuid: string;
  text: string;
  isThinking?: boolean;
}

interface SessionSummary {
  sessionId: string;
  firstMessage: string;
  messageCount: number;
  lastActivity: number;
}

export function SessionPanel({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const seenUUIDs = useRef(new Set<string>());
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputBuf = useRef("");

  const [splitPct, setSplitPct] = useState(70);
  const dragging = useRef(false);

  // Resume modal
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  const handleConversation = useCallback((entry: ConversationEntry) => {
    if (seenUUIDs.current.has(entry.uuid)) return;
    seenUUIDs.current.add(entry.uuid);
    if (entry.isThinking) return;
    setEntries((prev) => [...prev, entry]);
  }, []);

  const sendResume = useCallback((targetSessionId: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resume", data: targetSessionId }));
    }
    setShowResumeModal(false);
  }, []);

  const openResumeModal = useCallback(async () => {
    setShowResumeModal(true);
    setLoadingSessions(true);
    try {
      const resp = await fetch("/api/sessions");
      const data = await resp.json();
      setSessionList(data || []);
    } catch {
      setSessionList([]);
    }
    setLoadingSessions(false);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
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
    termRef.current = term;
    fitRef.current = fit;

    const wsUrl = `ws://${window.location.host}/ws?session=${encodeURIComponent(sessionId)}`;
    const ws = new WebSocket(wsUrl);
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
      } else if (msg.type === "conversation_reset") {
        term.reset();
        seenUUIDs.current.clear();
        setEntries([]);
      } else if (msg.type === "conversation" && msg.entry) {
        const entry = typeof msg.entry === "string" ? JSON.parse(msg.entry) : msg.entry;
        handleConversation(entry);
      }
    };

    ws.onclose = () => setConnected(false);

    // Intercept /resume command from terminal input
    term.onData((data) => {
      // Track input buffer to detect "/resume\r"
      if (data === "\r" || data === "\n") {
        const cmd = inputBuf.current.trim();
        if (cmd === "/resume") {
          inputBuf.current = "";
          openResumeModal();
          return; // Don't send to pty
        }
        inputBuf.current = "";
      } else if (data === "\x7f") {
        // Backspace
        inputBuf.current = inputBuf.current.slice(0, -1);
      } else if (data.length === 1 && data >= " ") {
        inputBuf.current += data;
      }

      // Forward to pty
      if (ws.readyState === WebSocket.OPEN) {
        const bytes = new TextEncoder().encode(data);
        const base64 = btoa(String.fromCharCode(...bytes));
        ws.send(JSON.stringify({ type: "input", data: base64 }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        sendResize(ws, cols, rows);
      }
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      ws.close();
      term.dispose();
    };
  }, [sessionId, handleConversation, openResumeModal]);

  // Re-fit when vertical split changes
  useEffect(() => {
    const id = setTimeout(() => fitRef.current?.fit(), 50);
    return () => clearTimeout(id);
  }, [splitPct]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  const onVDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const container = e.currentTarget.parentElement!;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const rect = container.getBoundingClientRect();
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setSplitPct(Math.max(10, Math.min(90, pct)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setTimeout(() => fitRef.current?.fit(), 50);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* Chat panel (top) */}
      <div
        style={{ height: `${splitPct}%` }}
        className="flex flex-col min-h-0 cursor-text"
        onClick={() => termRef.current?.focus()}
      >
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {!connected && (
            <div className="text-center text-yellow-400 text-sm">Connecting...</div>
          )}
          {entries.length === 0 && connected && (
            <div className="text-gray-600 text-sm text-center mt-4">
              Messages will appear here...
            </div>
          )}
          {entries.map((entry) => (
            <MessageBubble key={entry.uuid} entry={entry} />
          ))}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Vertical drag handle */}
      <div
        onMouseDown={onVDragStart}
        className="h-1 bg-gray-800 hover:bg-blue-600 cursor-row-resize flex-shrink-0 transition-colors"
      />

      {/* Terminal (bottom) */}
      <div style={{ height: `${100 - splitPct}%` }} className="min-h-0">
        <div ref={containerRef} className="h-full" />
      </div>

      {/* Resume modal */}
      {showResumeModal && (
        <ResumeModal
          sessions={sessionList}
          loading={loadingSessions}
          onSelect={sendResume}
          onClose={() => setShowResumeModal(false)}
        />
      )}
    </div>
  );
}

function ResumeModal({
  sessions,
  loading,
  onSelect,
  onClose,
}: {
  sessions: SessionSummary[];
  loading: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 bg-black/70 z-20 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg max-h-[80%] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-gray-100 font-medium">Resume Session</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-lg">×</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="text-gray-400 text-sm text-center py-8">Loading sessions...</div>
          )}
          {!loading && sessions.length === 0 && (
            <div className="text-gray-500 text-sm text-center py-8">No sessions found</div>
          )}
          {!loading && sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => onSelect(s.sessionId)}
              className="w-full text-left px-4 py-3 hover:bg-gray-800 border-b border-gray-800 transition-colors"
            >
              <div className="text-gray-200 text-sm truncate">{s.firstMessage}</div>
              <div className="text-gray-500 text-xs mt-1">
                {s.messageCount} messages · {formatRelativeTime(s.lastActivity)}
                <span className="text-gray-600 ml-2">{s.sessionId.slice(0, 8)}…</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatRelativeTime(tsMillis: number): string {
  const seconds = Math.floor((Date.now() - tsMillis) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function MessageBubble({ entry }: { entry: ConversationEntry }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-blue-900/40 border border-blue-800/50 px-3 py-1.5 text-gray-100 text-sm whitespace-pre-wrap">
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
