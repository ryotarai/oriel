import { useRef, useEffect, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { DiffPanel, type FileDiffData } from "./components/DiffPanel";
import { FileExplorer } from "./components/FileExplorer";
import { CommitsPanel } from "./components/CommitsPanel";

interface ConversationEntry {
  type: string;
  role: string;
  uuid: string;
  text: string;
  isThinking?: boolean;
  toolName?: string;
  toolInput?: string;
  toolUseId?: string;
  isError?: boolean;
}

interface TaskItem {
  taskId: string;
  subject: string;
  status: string;
}

interface SessionSummary {
  sessionId: string;
  firstMessage: string;
  messageCount: number;
  lastActivity: number;
}

export interface SessionPanelHandle {
  openResumeModal: () => void;
  openCwdPicker: () => void;
  focus: () => void;
}

interface SessionPanelProps {
  sessionId: string;
  dragHandleProps?: Record<string, unknown>;
  swapEnterKeys?: boolean;
  cwd?: string;
  onCwdChange?: (newCwd: string) => void;
  resumeSessionId?: string; // real Claude CLI session UUID for --resume
  onClaudeSessionId?: (uuid: string) => void;
}

export const SessionPanel = forwardRef<SessionPanelHandle, SessionPanelProps>(function SessionPanel({ sessionId, dragHandleProps, swapEnterKeys, cwd, onCwdChange, resumeSessionId, onClaudeSessionId }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const seenUUIDs = useRef(new Set<string>());
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const programmaticScroll = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const swapEnterRef = useRef(swapEnterKeys ?? true);
  useEffect(() => { swapEnterRef.current = swapEnterKeys ?? true; }, [swapEnterKeys]);

  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;

  const onClaudeSessionIdRef = useRef(onClaudeSessionId);
  onClaudeSessionIdRef.current = onClaudeSessionId;

  const prevCwdRef = useRef(cwd);
  useEffect(() => {
    if (prevCwdRef.current !== cwd && cwd && prevCwdRef.current !== undefined) {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "set_cwd", data: cwd }));
      }
    }
    prevCwdRef.current = cwd;
    setCwdInput(cwd ?? "");
  }, [cwd]);

  const [splitPct, setSplitPct] = useState(70);
  const dragging = useRef(false);
  const [activeTab, setActiveTab] = useState<"conversation" | "diff" | "files" | "commits">("conversation");
  const [diffFiles, setDiffFiles] = useState<FileDiffData[]>([]);
  const [fileToOpen, setFileToOpen] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [worktreeDir, setWorktreeDir] = useState("");
  const [running, setRunning] = useState(false);
  const [suggestions, setSuggestions] = useState<{ label: string; message: string }[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const effectiveDir = worktreeDir || cwd || "";

  const sendInputToTerminal = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const bytes = new TextEncoder().encode(text);
      const base64 = btoa(String.fromCharCode(...bytes));
      ws.send(JSON.stringify({ type: "input", data: base64 }));
    }
    termRef.current?.focus();
  }, []);

  const openFileInExplorer = useCallback((path: string) => {
    setFileToOpen(path);
    setActiveTab("files");
  }, []);

  // Resume modal
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [sessionList, setSessionList] = useState<SessionSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // CWD picker
  const [showCwdPicker, setShowCwdPicker] = useState(false);
  const [cwdInput, setCwdInput] = useState(cwd ?? "");
  const [cwdBrowsePath, setCwdBrowsePath] = useState(cwd ?? "");
  const [cwdDirEntries, setCwdDirEntries] = useState<{ name: string; path: string }[]>([]);
  const [cwdDirLoading, setCwdDirLoading] = useState(false);

  const fetchDirs = useCallback((dirPath: string) => {
    setCwdDirLoading(true);
    const params = new URLSearchParams();
    if (dirPath) params.set("path", dirPath);
    fetch(`/api/dirs?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data: { path: string; parent: string; entries: { name: string; path: string }[] }) => {
        setCwdBrowsePath(data.path);
        setCwdInput(data.path);
        setCwdDirEntries(data.entries ?? []);
      })
      .catch(() => setCwdDirEntries([]))
      .finally(() => setCwdDirLoading(false));
  }, []);

  const handleConversation = useCallback((entry: ConversationEntry) => {
    if (seenUUIDs.current.has(entry.uuid)) return;
    seenUUIDs.current.add(entry.uuid);
    if (entry.isThinking) return;
    setEntries((prev) => [...prev, entry]);
  }, []);

  const sendResume = useCallback((targetSessionId: string) => {
    // Save the resume target to DB immediately so it persists across restarts
    onClaudeSessionIdRef.current?.(targetSessionId);
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

  useImperativeHandle(ref, () => ({
    openResumeModal,
    openCwdPicker: () => { setShowCwdPicker(true); fetchDirs(cwd ?? ""); },
    focus: () => { termRef.current?.focus(); },
  }), [openResumeModal, fetchDirs, cwd]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
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

    const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
    const resumeParam = resumeSessionId ? `&resume=${encodeURIComponent(resumeSessionId)}` : "";
    const wsUrl = `ws://${window.location.host}/ws?session=${encodeURIComponent(sessionId)}${cwdParam}${resumeParam}`;
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
        setSuggestions([]);
        setSuggestionsLoading(false);
        setWorktreeDir("");
      } else if (msg.type === "worktree_changed" && msg.data) {
        setWorktreeDir(msg.data);
      } else if (msg.type === "cwd" && msg.data) {
        onCwdChangeRef.current?.(msg.data);
      } else if (msg.type === "claude_session_id" && msg.data) {
        onClaudeSessionIdRef.current?.(msg.data);
      } else if (msg.type === "conversation" && msg.entry) {
        const entry = typeof msg.entry === "string" ? JSON.parse(msg.entry) : msg.entry;
        handleConversation(entry);
      } else if (msg.type === "suggestions") {
        try {
          const parsed = JSON.parse(msg.data);
          setSuggestions(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          console.warn("Failed to parse suggestions:", e);
        }
        setSuggestionsLoading(false);
      } else if (msg.type === "suggestions_error") {
        setSuggestionsLoading(false);
      }
    };

    ws.onclose = () => setConnected(false);

    // Plain Enter → Ctrl+J (newline) when swap is enabled, otherwise normal Enter
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Don't intercept IME composition events (e.g. Japanese input confirm)
      if (e.isComposing || e.keyCode === 229) return true;
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        if (!swapEnterRef.current) return true; // Swap disabled — normal Enter
        // Send Ctrl+J (\n) instead of \r
        e.preventDefault();
        const bytes = new TextEncoder().encode("\n");
        const base64 = btoa(String.fromCharCode(...bytes));
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: base64 }));
        }
        return false;
      }
      return true;
    });

    term.onData((data) => {
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
  }, [sessionId, handleConversation]);

  // Re-fit when vertical split changes
  useEffect(() => {
    const id = setTimeout(() => fitRef.current?.fit(), 50);
    return () => clearTimeout(id);
  }, [splitPct]);

  // Track whether user is near the bottom of the chat scroll container
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (programmaticScroll.current) return;
      const threshold = 80;
      isNearBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll chat only when user is near the bottom
  useEffect(() => {
    if (isNearBottom.current) {
      const el = chatScrollRef.current;
      if (el) {
        programmaticScroll.current = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          programmaticScroll.current = false;
        });
      }
    }
  }, [entries]);

  // Extract task state from conversation entries
  useEffect(() => {
    const taskMap = new Map<string, TaskItem>();

    // Pass 1: process TaskCreate tool_use entries, keyed by toolUseId
    for (const entry of entries) {
      if (entry.type !== "tool_use" || entry.toolName !== "TaskCreate") continue;
      try {
        const input = JSON.parse(entry.toolInput ?? "{}");
        taskMap.set(entry.toolUseId ?? entry.uuid, {
          taskId: entry.toolUseId ?? entry.uuid,
          subject: input.subject ?? "Task",
          status: "pending",
        });
      } catch {}
    }

    // Pass 2: resolve numeric taskIds from tool_result entries so TaskUpdate can match
    for (const entry of entries) {
      if (entry.type !== "tool_result" || !entry.toolUseId) continue;
      const matchingUse = entries.find(
        (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId && e.toolName === "TaskCreate"
      );
      if (matchingUse && entry.text) {
        const idMatch = entry.text.match(/Task #(\d+)/i) || entry.text.match(/#(\d+)/);
        if (idMatch) {
          const existing = taskMap.get(matchingUse.toolUseId ?? matchingUse.uuid);
          if (existing) {
            existing.taskId = idMatch[1];
          }
        }
      }
    }

    // Pass 3: process TaskUpdate tool_use entries — numeric taskIds are now resolved
    for (const entry of entries) {
      if (entry.type !== "tool_use" || entry.toolName !== "TaskUpdate") continue;
      try {
        const input = JSON.parse(entry.toolInput ?? "{}");
        const targetId = input.taskId;
        if (targetId) {
          for (const [, task] of taskMap) {
            if (task.taskId === targetId || task.taskId.endsWith(`-${targetId}`)) {
              if (input.status) task.status = input.status;
              if (input.subject) task.subject = input.subject;
              break;
            }
          }
        }
      } catch {}
    }

    setTasks(Array.from(taskMap.values()));
  }, [entries]);

  // Detect running state from conversation entries
  useEffect(() => {
    if (entries.length === 0) {
      setRunning(false);
      return;
    }
    const last = entries[entries.length - 1];
    // Claude is done when the last entry is assistant text (final response).
    // Otherwise (tool_use, tool_result, user input), Claude is actively working.
    setRunning(last.type !== "assistant");
  }, [entries]);

  // Request reply suggestions when session becomes idle
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;

    if (wasRunning && !running && entries.length > 0) {
      // Session just finished — request suggestions
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        setSuggestions([]);
        setSuggestionsLoading(true);
        ws.send(JSON.stringify({ type: "request_suggestions" }));
      }
    }
  }, [running]);

  // Clear suggestions when user sends a new message (session becomes running again)
  useEffect(() => {
    if (running) {
      setSuggestions([]);
      setSuggestionsLoading(false);
    }
  }, [running]);

  // Quote-reply: press "r" with selected text to insert as quote into terminal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "r" || e.ctrlKey || e.metaKey || e.altKey) return;
      const sel = window.getSelection();
      const text = sel?.toString();
      if (!text) return;

      // Only act if the selection is within this panel
      const anchor = sel?.anchorNode;
      if (!anchor || !panelRef.current?.contains(anchor as Node)) return;

      const ws = wsRef.current;
      const term = termRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;

      e.preventDefault();
      const quoted = text.split("\n").map((line) => `> ${line}`).join("\n") + "\n";
      const bytes = new TextEncoder().encode(quoted);
      const base64 = btoa(String.fromCharCode(...bytes));
      ws.send(JSON.stringify({ type: "input", data: base64 }));
      sel?.removeAllRanges();
      term.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Ctrl+F / Cmd+F search shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        if (activeTab !== "conversation") return;
        if (!panelRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeTab]);

  // Search match computation
  const searchMatches = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    const matches: { entryIdx: number; uuid: string }[] = [];
    entries.forEach((entry, i) => {
      if (entry.text?.toLowerCase().includes(q)) {
        matches.push({ entryIdx: i, uuid: entry.uuid });
      }
    });
    return matches;
  }, [entries, searchQuery]);

  const totalMatches = searchMatches.length;
  const currentMatchIdx = totalMatches > 0 ? ((searchMatchIdx % totalMatches) + totalMatches) % totalMatches : 0;

  // Scroll to current search match
  useEffect(() => {
    if (!searchQuery || searchMatches.length === 0) return;
    const match = searchMatches[currentMatchIdx];
    if (!match) return;
    const el = document.getElementById(`msg-${match.uuid}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentMatchIdx, searchMatches, searchQuery]);

  // Poll diff API
  useEffect(() => {
    const poll = () => {
      const cwdParam = effectiveDir ? `&cwd=${encodeURIComponent(effectiveDir)}` : "";
      fetch(`/api/diff?session=${encodeURIComponent(sessionId)}${cwdParam}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.files) setDiffFiles(data.files);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [sessionId, effectiveDir]);

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
    <div ref={panelRef} className={`h-full flex flex-col overflow-hidden relative border ${running ? "pane-running" : "border-transparent"} transition-colors duration-500`}>
      {/* Chat panel (top) */}
      <div
        style={{ height: `${splitPct}%` }}
        className="flex flex-col min-h-0"
      >
        {/* Tab bar */}
        <div
          className="flex-shrink-0 flex border-b border-gray-800 bg-gray-900/50 pl-2 pr-24 cursor-grab active:cursor-grabbing"
          {...dragHandleProps}
        >
          <button
            onClick={() => setActiveTab("conversation")}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === "conversation"
                ? "text-gray-100 border-b-2 border-blue-500"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Conversation
          </button>
          <button
            onClick={() => setActiveTab("diff")}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === "diff"
                ? "text-gray-100 border-b-2 border-blue-500"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Diff
            {diffFiles.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-300 text-[10px]">
                {diffFiles.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("files")}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === "files"
                ? "text-gray-100 border-b-2 border-blue-500"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Files
          </button>
          <button
            onClick={() => setActiveTab("commits")}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === "commits"
                ? "text-gray-100 border-b-2 border-blue-500"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Commits
          </button>
        </div>

        {/* Tab content - all tabs always mounted, hidden when inactive */}
        <div className={`flex-1 flex flex-col min-h-0 relative ${activeTab !== "conversation" ? "hidden" : ""}`}>
            <TaskOverlay tasks={tasks} />
            <div className="flex items-center px-3 py-1 border-b border-gray-800">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showTools}
                  onChange={(e) => setShowTools(e.target.checked)}
                  className="accent-blue-500"
                />
                Show tools
              </label>
            </div>
            {searchOpen && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 bg-gray-900/80">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setSearchMatchIdx(0); }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); }
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setSearchMatchIdx(i => i + 1); }
                    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); setSearchMatchIdx(i => Math.max(0, i - 1)); }
                  }}
                  placeholder="Search..."
                  className="flex-1 bg-gray-800 text-gray-200 text-xs px-2 py-1 rounded border border-gray-700 outline-none focus:border-blue-500"
                  autoFocus
                />
                <span className="text-xs text-gray-500 min-w-[3rem] text-center">
                  {searchQuery ? `${totalMatches > 0 ? currentMatchIdx + 1 : 0}/${totalMatches}` : ""}
                </span>
                <button onClick={() => setSearchMatchIdx(i => Math.max(0, i - 1))} className="text-gray-400 hover:text-gray-200 text-xs px-1">&#9650;</button>
                <button onClick={() => setSearchMatchIdx(i => i + 1)} className="text-gray-400 hover:text-gray-200 text-xs px-1">&#9660;</button>
                <button onClick={() => { setSearchOpen(false); setSearchQuery(""); }} className="text-gray-400 hover:text-gray-200 text-xs px-1">&#10005;</button>
              </div>
            )}
            <div
              ref={chatScrollRef}
              className="flex-1 overflow-y-auto scrollbar-auto-hide p-3 space-y-3 flex flex-col min-h-0 cursor-text"
            onClick={() => {
              const sel = window.getSelection();
              if (sel && sel.toString().length > 0) return;
              termRef.current?.focus();
            }}
          >
            <div className="flex flex-col space-y-3 mt-auto">
              {!connected && (
                <div className="text-center text-yellow-400 text-sm">Connecting...</div>
              )}
              {entries.length === 0 && connected && (
                <div className="text-gray-600 text-sm text-center mt-4">
                  Messages will appear here...
                </div>
              )}
              {entries.filter((entry) => {
                if (!showTools && entry.type === "tool_use") return false;
                if (!showTools && entry.type === "tool_result") {
                  // Show Agent tool results even when tools are hidden
                  const matchingUse = entries.find(
                    (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId
                  );
                  if (!matchingUse || matchingUse.toolName !== "Agent") return false;
                }
                // Hide TaskCreate/TaskUpdate tool blocks (shown as overlay instead)
                if (entry.type === "tool_use" && (entry.toolName === "TaskCreate" || entry.toolName === "TaskUpdate")) {
                  return false;
                }
                // Hide tool results for TaskCreate, TaskUpdate
                if (entry.type === "tool_result") {
                  const matchingUse = entries.find(
                    (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId
                  );
                  if (matchingUse && (matchingUse.toolName === "TaskCreate" || matchingUse.toolName === "TaskUpdate")) {
                    return false;
                  }
                  // Hide successful Edit/Write results but show errors
                  if (matchingUse && (matchingUse.toolName === "Edit" || matchingUse.toolName === "Write") && !entry.isError) {
                    return false;
                  }
                }
                return true;
              }).map((entry) => {
                // Render Agent tool results as assistant messages (markdown)
                const isAgentResult = entry.type === "tool_result" && (() => {
                  const matchingUse = entries.find(
                    (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId
                  );
                  return matchingUse?.toolName === "Agent";
                })();
                const isCurrentSearchMatch = searchQuery && searchMatches[currentMatchIdx]?.uuid === entry.uuid;
                const isAnySearchMatch = searchQuery && entry.text?.toLowerCase().includes(searchQuery.toLowerCase());
                return (
                  <div
                    key={entry.uuid}
                    id={`msg-${entry.uuid}`}
                    className={isAnySearchMatch ? (isCurrentSearchMatch ? "ring-2 ring-yellow-500/50 rounded-lg" : "ring-1 ring-yellow-500/20 rounded-lg") : ""}
                  >
                    <MessageBubble
                      entry={isAgentResult ? { ...entry, type: "assistant", role: "assistant" } : entry}
                      onOpenFile={openFileInExplorer}
                    />
                  </div>
                );
              })}
              <div ref={chatEndRef} />
              {/* Reply suggestions */}
              {suggestionsLoading && (
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <svg className="animate-spin h-3.5 w-3.5 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span className="text-xs text-gray-400">Suggesting replies...</span>
                </div>
              )}
              {suggestions.length > 0 && !running && (
                <div className="flex gap-2 flex-wrap px-1 pb-1">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        sendInputToTerminal(s.message + "\r");
                        setSuggestions([]);
                      }}
                      className="text-xs px-3 py-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 hover:border-blue-500/50 transition-colors cursor-pointer"
                      title={s.message}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          </div>
        <div className={`flex-1 flex flex-col min-h-0 ${activeTab !== "diff" ? "hidden" : ""}`}>
            <DiffPanel files={diffFiles} onSendInput={sendInputToTerminal} cwd={effectiveDir || undefined} />
          </div>
        <div className={`flex-1 flex flex-col min-h-0 ${activeTab !== "commits" ? "hidden" : ""}`}>
            <CommitsPanel cwd={effectiveDir || undefined} />
          </div>
        <div className={`flex-1 flex flex-col min-h-0 ${activeTab !== "files" ? "hidden" : ""}`}>
            <FileExplorer requestedPath={fileToOpen} onSendInput={sendInputToTerminal} cwd={effectiveDir || undefined} />
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

      {/* CWD picker modal */}
      {showCwdPicker && (
        <div className="absolute inset-0 bg-black/70 z-20 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md p-4 flex flex-col max-h-[80vh]">
            <h3 className="text-gray-100 text-sm font-medium mb-2">Change Working Directory</h3>
            <p className="text-yellow-400 text-xs mb-3">This will restart the Claude Code session.</p>
            <input
              type="text"
              value={cwdInput}
              onChange={(e) => setCwdInput(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 text-gray-200 text-sm px-3 py-1.5 rounded font-mono mb-2 shrink-0"
              placeholder="/path/to/directory"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && cwdInput.trim()) {
                  fetchDirs(cwdInput.trim());
                }
                if (e.key === "Escape") setShowCwdPicker(false);
              }}
            />
            <div className="flex-1 overflow-y-auto border border-gray-700 rounded bg-gray-800 min-h-0">
              {cwdDirLoading ? (
                <div className="text-gray-500 text-xs p-3">Loading...</div>
              ) : (
                <div className="divide-y divide-gray-700/50">
                  {cwdBrowsePath !== "/" && (
                    <button
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
                      onClick={() => {
                        const parent = cwdBrowsePath.replace(/\/[^/]+$/, "") || "/";
                        fetchDirs(parent);
                      }}
                    >
                      <span className="text-gray-500">&#128193;</span>
                      <span>..</span>
                    </button>
                  )}
                  {cwdDirEntries.map((entry) => (
                    <button
                      key={entry.path}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
                      onClick={() => fetchDirs(entry.path)}
                    >
                      <span className="text-gray-500">&#128193;</span>
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ))}
                  {cwdDirEntries.length === 0 && (
                    <div className="text-gray-500 text-xs p-3">No subdirectories</div>
                  )}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-3 shrink-0">
              <button
                onClick={() => setShowCwdPicker(false)}
                className="text-gray-400 text-xs px-3 py-1 rounded hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (cwdBrowsePath.trim()) {
                    onCwdChange?.(cwdBrowsePath.trim());
                    setShowCwdPicker(false);
                  }
                }}
                className="bg-blue-600 text-white text-xs px-3 py-1 rounded hover:bg-blue-500"
              >
                Select
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

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

interface BashParts {
  input?: string;
  stdout?: string;
  stderr?: string;
}

function parseBashTags(text: string): BashParts | null {
  const inputMatch = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  const stdoutMatch = text.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
  const stderrMatch = text.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
  if (!inputMatch && !stdoutMatch && !stderrMatch) return null;
  return {
    input: inputMatch?.[1],
    stdout: stdoutMatch?.[1],
    stderr: stderrMatch?.[1],
  };
}

function BashBlock({ parts }: { parts: BashParts }) {
  return (
    <div className="rounded-lg bg-gray-900 border border-gray-700 overflow-hidden text-xs font-mono">
      {parts.input != null && (
        <div className="px-3 py-1.5 bg-gray-800/60 border-b border-gray-700 text-gray-200 flex items-center gap-1.5">
          <span className="text-green-400">$</span>
          <span>{parts.input}</span>
        </div>
      )}
      {parts.stdout && (
        <div className="px-3 py-1.5 text-gray-300 whitespace-pre-wrap">{parts.stdout}</div>
      )}
      {parts.stderr && (
        <div className="px-3 py-1.5 text-red-400 whitespace-pre-wrap">{parts.stderr}</div>
      )}
    </div>
  );
}

function MessageBubble({ entry, onOpenFile }: { entry: ConversationEntry; onOpenFile?: (path: string) => void }) {
  if (entry.type === "tool_use") {
    return <ToolUseBlock entry={entry} />;
  }

  if (entry.type === "tool_result") {
    return <ToolResultBlock entry={entry} />;
  }

  if (entry.role === "user") {
    const bash = parseBashTags(entry.text);
    if (bash) {
      return (
        <div className="my-1">
          <BashBlock parts={bash} />
        </div>
      );
    }

    // Skip meta markers like [Request interrupted by user]
    if (/^\[.*\]$/.test(entry.text.trim())) return null;

    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl bg-blue-900/40 border border-blue-800/50 px-3 py-1.5 text-gray-100 text-sm whitespace-pre-wrap">
          {entry.text}
        </div>
      </div>
    );
  }

  return (
    <div className="relative group">
      <button
        onClick={() => navigator.clipboard.writeText(entry.text)}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-gray-300 p-1"
        title="Copy message"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeWidth="2"/>
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeWidth="2"/>
        </svg>
      </button>
      <div className="prose prose-invert prose-sm max-w-none
        prose-headings:text-gray-100 prose-headings:mt-3 prose-headings:mb-1
        prose-p:text-gray-200 prose-p:leading-relaxed prose-p:my-1
        prose-li:text-gray-200 prose-li:my-0
        prose-code:text-blue-300 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
        prose-pre:bg-gray-900 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded-lg prose-pre:my-2
        prose-a:text-blue-400
        prose-strong:text-gray-100
      ">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            a: ({ children, ...props }) => (
              <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
            ),
            pre: ({ children, ...props }) => {
              const extractText = (node: React.ReactNode): string => {
                if (typeof node === "string") return node;
                if (Array.isArray(node)) return node.map(extractText).join("");
                if (node && typeof node === "object" && "props" in node) {
                  return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
                }
                return "";
              };
              const text = extractText(children);
              return (
                <div className="relative group/code">
                  <button
                    onClick={() => navigator.clipboard.writeText(text)}
                    className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity bg-gray-700 hover:bg-gray-600 text-gray-300 rounded px-1.5 py-0.5 text-[10px]"
                    title="Copy code"
                  >
                    Copy
                  </button>
                  <pre {...props}>{children}</pre>
                </div>
              );
            },
            code: ({ children, className, ...props }) => {
              // For code blocks (has language class), use default rendering
              if (className) {
                return <code className={className} {...props}>{children}</code>;
              }
              // For inline code, check if it looks like a file path
              const text = typeof children === "string" ? children : String(children ?? "");
              if (onOpenFile && isFilePath(text)) {
                // Strip line number suffix like :42
                const cleanPath = text.replace(/:\d+(-\d+)?$/, "");
                return (
                  <code
                    className="cursor-pointer hover:underline hover:text-blue-300"
                    onClick={(e) => { e.stopPropagation(); onOpenFile(cleanPath); }}
                    title="Open in File Explorer"
                    {...props}
                  >
                    {children}
                  </code>
                );
              }
              return <code {...props}>{children}</code>;
            },
          }}
        >
          {entry.text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function ToolUseBlock({ entry }: { entry: ConversationEntry }) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolUseSummary(entry.toolName ?? "", entry.toolInput ?? "");

  let parsedInput: Record<string, unknown> | null = null;
  try {
    parsedInput = JSON.parse(entry.toolInput ?? "{}");
  } catch {}

  const isWrite = entry.toolName === "Write";
  const isEdit = entry.toolName === "Edit";

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-1.5 hover:bg-gray-800 transition-colors"
      >
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">{expanded ? "▼" : "▶"}</span>
          <span className="text-green-400 font-medium">{entry.toolName}</span>
          <span className="text-gray-400 truncate">{summary}</span>
        </div>
      </button>
      {expanded && isWrite && parsedInput?.content != null && (
        <div className="mt-1 rounded-lg bg-gray-900 border border-gray-700/50 overflow-hidden">
          <pre className="px-3 py-2 text-xs font-mono text-gray-300 whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto">
            {String(parsedInput.content)}
          </pre>
        </div>
      )}
      {expanded && isEdit && parsedInput && (
        <div className="mt-1 rounded-lg bg-gray-900 border border-gray-700/50 overflow-hidden">
          <EditDiff
            oldStr={String(parsedInput.old_string ?? "")}
            newStr={String(parsedInput.new_string ?? "")}
          />
        </div>
      )}
      {expanded && !isWrite && !isEdit && entry.toolInput && (
        <div className="mt-1 rounded-lg bg-gray-900 border border-gray-700/50 px-3 py-2 text-xs font-mono text-gray-300 whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto">
          {formatToolInput(entry.toolInput)}
        </div>
      )}
    </div>
  );
}

function EditDiff({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  return (
    <pre className="px-3 py-2 text-xs font-mono max-h-60 overflow-y-auto">
      {oldLines.map((line, i) => (
        <div key={`old-${i}`} className="text-red-300 bg-red-900/20">
          <span className="select-none text-red-500 mr-1">-</span>{line || "\u00a0"}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`new-${i}`} className="text-green-300 bg-green-900/20">
          <span className="select-none text-green-500 mr-1">+</span>{line || "\u00a0"}
        </div>
      ))}
    </pre>
  );
}

function ToolResultBlock({ entry }: { entry: ConversationEntry }) {
  const [expanded, setExpanded] = useState(false);
  const text = entry.text || "";
  const lines = text.split("\n");
  const preview = lines.slice(0, 3).join("\n");
  const hasMore = lines.length > 3;

  if (!text) return null;

  return (
    <div className="my-1 ml-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left rounded-lg bg-gray-900/50 border border-gray-700/30 px-3 py-1.5 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">{expanded ? "▼" : "▶"}</span>
          <span className={entry.isError ? "text-red-400" : "text-gray-500"}>
            {entry.isError ? "Error" : "Result"}
          </span>
          <span className="text-gray-500 text-[10px]">
            {lines.length} line{lines.length !== 1 ? "s" : ""}
          </span>
        </div>
      </button>
      {expanded && (
        <div className={`mt-1 rounded-lg bg-gray-900 border px-3 py-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-80 overflow-y-auto ${
          entry.isError ? "border-red-800/50 text-red-300" : "border-gray-700/50 text-gray-400"
        }`}>
          {text}
        </div>
      )}
      {!expanded && hasMore && (
        <div className="mt-1 px-3 text-xs font-mono text-gray-500 whitespace-pre-wrap truncate">
          {preview}…
        </div>
      )}
      {!expanded && !hasMore && (
        <div className="mt-1 px-3 text-xs font-mono text-gray-500 whitespace-pre-wrap">
          {preview}
        </div>
      )}
    </div>
  );
}

function TaskOverlay({ tasks }: { tasks: TaskItem[] }) {
  const [collapsed, setCollapsed] = useState(false);

  if (tasks.length === 0) return null;

  return (
    <div className="absolute top-10 right-2 z-10 w-64 bg-gray-900/95 border border-gray-700 rounded-lg shadow-lg backdrop-blur-sm overflow-hidden">
      <div className="px-3 py-1.5 border-b border-gray-700 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-300">Tasks</span>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-gray-500 hover:text-gray-300 text-xs leading-none"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "+" : "−"}
        </button>
      </div>
      {!collapsed && (
        <div className="max-h-48 overflow-y-auto">
          {tasks.map((task) => (
            <div key={task.taskId} className="px-3 py-1 flex items-center gap-2 text-xs">
              <span className={
                task.status === "completed" ? "text-green-400" :
                task.status === "in_progress" ? "text-yellow-400" :
                "text-gray-500"
              }>
                {task.status === "completed" ? "✓" : task.status === "in_progress" ? "●" : "○"}
              </span>
              <span className={
                task.status === "completed" ? "text-gray-500 line-through" : "text-gray-300"
              }>
                {task.subject}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function toolUseSummary(name: string, inputJson: string): string {
  try {
    const input = JSON.parse(inputJson);
    switch (name) {
      case "Bash":
        return input.command ? `$ ${input.command}` : "";
      case "Read":
        return input.file_path ?? "";
      case "Write":
        return input.file_path ?? "";
      case "Edit":
        return input.file_path ?? "";
      case "Glob":
        return input.pattern ?? "";
      case "Grep":
        return input.pattern ?? "";
      case "Agent":
        return input.description ?? input.prompt?.slice(0, 60) ?? "";
      case "Skill":
        return input.skill ?? "";
      case "TaskCreate":
        return input.subject ?? "";
      case "TaskUpdate":
        return `#${input.taskId} → ${input.status ?? "update"}`;
      default:
        return "";
    }
  } catch {
    return "";
  }
}

function isFilePath(text: string): boolean {
  // Strip trailing line number like :42 or :42-50
  const cleaned = text.replace(/:\d+(-\d+)?$/, "");
  // Must contain a slash or dot-extension, look like a relative or absolute path
  if (!cleaned.includes("/") && !cleaned.includes(".")) return false;
  // Must not contain spaces (file paths in code rarely have spaces)
  if (cleaned.includes(" ")) return false;
  // Must have a file extension or end with a dir-like path
  if (/\.\w{1,10}$/.test(cleaned)) return true;
  // Paths like src/components/ or internal/ws
  if (/^[\w./-]+$/.test(cleaned) && cleaned.includes("/")) return true;
  return false;
}

function formatToolInput(inputJson: string): string {
  try {
    const parsed = JSON.parse(inputJson);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return inputJson;
  }
}

function sendResize(ws: WebSocket, cols: number, rows: number) {
  ws.send(JSON.stringify({ type: "resize", cols, rows }));
}
