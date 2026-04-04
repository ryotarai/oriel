import { useRef, useEffect, useLayoutEffect, useState, useCallback, useImperativeHandle, forwardRef, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { MermaidBlock } from "./components/MermaidBlock";
import { DiffPanel, type FileDiffData } from "./components/DiffPanel";
import { FileExplorer } from "./components/FileExplorer";
import { CommitsPanel } from "./components/CommitsPanel";

interface ConversationEntry {
  type: string;
  role: string;
  uuid: string;
  text: string;
  timestamp?: string;
  isThinking?: boolean;
  toolName?: string;
  toolInput?: string;
  toolUseId?: string;
  isError?: boolean;
  imageData?: string;
  imageMediaType?: string;
}

interface TaskItem {
  taskId: string;
  subject: string;
  status: string;
}

export interface SessionPanelHandle {
  openCwdPicker: () => void;
  focus: () => void;
}

interface SessionPanelProps {
  sessionId: string;
  dragHandleProps?: Record<string, unknown>;
  swapEnterKeys?: boolean;
  cwd?: string;
  onCwdChange?: (newCwd: string) => void;
  isFocused?: boolean;
  resumeSessionId?: string; // real Claude CLI session UUID for --resume
  onClaudeSessionId?: (uuid: string) => void;
}

export const SessionPanel = forwardRef<SessionPanelHandle, SessionPanelProps>(function SessionPanel({ sessionId, dragHandleProps, swapEnterKeys, isFocused, cwd, onCwdChange, resumeSessionId, onClaudeSessionId }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const seenUUIDs = useRef(new Set<string>());
  const convEpoch = useRef<number>(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const programmaticScroll = useRef(false);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const swapEnterRef = useRef(swapEnterKeys ?? true);
  useEffect(() => { swapEnterRef.current = swapEnterKeys ?? true; }, [swapEnterKeys]);

  // Request notification permission on mount
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

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

  const [textareaMode, setTextareaMode] = useState(false);
  const [textareaValue, setTextareaValue] = useState("");
  const [editorMode, setEditorMode] = useState(false); // true when opened via $EDITOR
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Focus textarea when entering textarea mode
  useEffect(() => {
    if (textareaMode) {
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [textareaMode]);

  const openFileInExplorer = useCallback((path: string) => {
    setFileToOpen(path);
    setActiveTab("files");
  }, []);

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

  useImperativeHandle(ref, () => ({
    openCwdPicker: () => { setShowCwdPicker(true); fetchDirs(cwd ?? ""); },
    focus: () => { termRef.current?.focus(); },
  }), [fetchDirs, cwd]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
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

    let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
    let intentionalClose = false;

    function connectWs() {
      const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
      const resumeParam = resumeSessionId ? `&resume=${encodeURIComponent(resumeSessionId)}` : "";
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws?session=${encodeURIComponent(sessionId)}${cwdParam}${resumeParam}`;
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
          convEpoch.current = msg.epoch ?? 0;
          setEntries([]);
          setSuggestions([]);
          setSuggestionsLoading(false);
          setWorktreeDir("");
        } else if (msg.type === "worktree_changed") {
          setWorktreeDir(msg.data || "");
        } else if (msg.type === "cwd" && msg.data) {
          onCwdChangeRef.current?.(msg.data);
        } else if (msg.type === "claude_session_id" && msg.data) {
          onClaudeSessionIdRef.current?.(msg.data);
        } else if (msg.type === "conversation" && msg.entry) {
          // Ignore stale conversation entries from old watchConversation goroutines
          if (msg.epoch !== undefined && msg.epoch < convEpoch.current) {
            return;
          }
          const entry = typeof msg.entry === "string" ? JSON.parse(msg.entry) : msg.entry;
          handleConversation(entry);
        } else if (msg.type === "running") {
          setRunning(msg.data === "true");
        } else if (msg.type === "suggestions_loading") {
          setSuggestions([]);
          setSuggestionsLoading(true);
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
        } else if (msg.type === "files_changed") {
          fetchDiffDataRef.current();
          setFileRefreshTrigger(c => c + 1);
        } else if (msg.type === "editor_open") {
          setEditorMode(true);
          setTextareaMode(true);
          setTextareaValue(msg.data || "");
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setSuggestionsLoading(false);
        if (!intentionalClose) {
          reconnectTimerId = setTimeout(connectWs, 5000);
        }
      };
    }

    connectWs();

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
        const currentWs = wsRef.current;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({ type: "input", data: base64 }));
        }
        return false;
      }
      return true;
    });

    term.onData((data) => {
      const currentWs = wsRef.current;
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        const bytes = new TextEncoder().encode(data);
        const base64 = btoa(String.fromCharCode(...bytes));
        currentWs.send(JSON.stringify({ type: "input", data: base64 }));
      }
    });

    term.onResize(({ cols, rows }) => {
      const currentWs = wsRef.current;
      if (currentWs && currentWs.readyState === WebSocket.OPEN) {
        sendResize(currentWs, cols, rows);
      }
    });

    // Enable cursor blink only when terminal is focused
    term.textarea?.addEventListener("focus", () => {
      term.options.cursorBlink = true;
    });
    term.textarea?.addEventListener("blur", () => {
      term.options.cursorBlink = false;
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(containerRef.current);

    return () => {
      intentionalClose = true;
      if (reconnectTimerId) clearTimeout(reconnectTimerId);
      observer.disconnect();
      wsRef.current?.close();
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
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      isNearBottom.current = nearBottom;
      if (nearBottom) {
        setShowNewMessages(false);
      }
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll chat only when user is near the bottom
  useLayoutEffect(() => {
    if (isNearBottom.current) {
      const el = chatScrollRef.current;
      if (el) {
        programmaticScroll.current = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          // Second scroll to catch late layout changes (e.g., mermaid diagrams)
          el.scrollTop = el.scrollHeight;
          requestAnimationFrame(() => {
            programmaticScroll.current = false;
          });
        });
      }
    } else {
      setShowNewMessages(true);
    }
  }, [entries, suggestionsLoading, suggestions]);

  // Scroll to bottom when switching back to conversation tab
  useEffect(() => {
    if (activeTab === "conversation" && isNearBottom.current) {
      const el = chatScrollRef.current;
      if (el) {
        programmaticScroll.current = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          programmaticScroll.current = false;
        });
      }
    }
  }, [activeTab]);

  // Scroll to bottom when container becomes visible (e.g., workspace tab switch)
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((resizeEntries) => {
      for (const entry of resizeEntries) {
        if (entry.contentRect.height > 0 && isNearBottom.current) {
          programmaticScroll.current = true;
          el.scrollTop = el.scrollHeight;
          requestAnimationFrame(() => {
            programmaticScroll.current = false;
          });
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
        if (!isFocused) return;
        if (activeTab !== "conversation") return;
        if (textareaMode) return;
        if (!panelRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, textareaMode, isFocused]);

  // Active tool entry computation
  const activeToolEntry = useMemo(() => {
    if (showTools || !running) return null;
    const last = entries[entries.length - 1];
    if (!last) return null;
    const ignored = ["TaskCreate", "TaskUpdate", "ExitPlanMode"];
    if (last.type === "tool_use" && !ignored.includes(last.toolName ?? "")) return last;
    if (last.type === "tool_result") {
      const use = entries.find((e) => e.type === "tool_use" && e.toolUseId === last.toolUseId);
      if (use && !ignored.includes(use.toolName ?? "")) return use;
    }
    return null;
  }, [entries, showTools, running]);

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

  // Fetch diff data (called on mount and when files_changed event received via WS)
  const fetchDiffData = useCallback(() => {
    const cwdParam = effectiveDir ? `&cwd=${encodeURIComponent(effectiveDir)}` : "";
    fetch(`/api/diff?session=${encodeURIComponent(sessionId)}${cwdParam}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        setDiffFiles(data?.files ?? []);
      })
      .catch(() => {});
  }, [sessionId, effectiveDir]);

  const fetchDiffDataRef = useRef(fetchDiffData);
  useEffect(() => { fetchDiffDataRef.current = fetchDiffData; }, [fetchDiffData]);

  // Counter to trigger FileExplorer tree refresh on file changes
  const [fileRefreshTrigger, setFileRefreshTrigger] = useState(0);

  useEffect(() => {
    fetchDiffData();
  }, [fetchDiffData]);

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
    <div ref={panelRef} className={`h-full flex flex-col overflow-hidden relative border-2 ${isFocused ? "border-blue-500/50" : "border-transparent transition-colors duration-500"}`}>
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
            <TaskOverlay tasks={tasks} searchOpen={searchOpen} />
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
                <div className="text-center text-yellow-400 text-sm">
                  {entries.length > 0 ? "Reconnecting..." : "Connecting..."}
                </div>
              )}
              {entries.length === 0 && connected && (
                <div className="text-gray-600 text-sm text-center mt-4">
                  Messages will appear here...
                </div>
              )}
              {entries.filter((entry) => {
                // Always show ExitPlanMode tool_use (rendered as markdown plan)
                if (entry.type === "tool_use" && entry.toolName === "ExitPlanMode") return true;
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
                  if (matchingUse && (matchingUse.toolName === "TaskCreate" || matchingUse.toolName === "TaskUpdate" || matchingUse.toolName === "ExitPlanMode")) {
                    return false;
                  }
                  // Hide successful Edit/Write results but show errors
                  if (matchingUse && (matchingUse.toolName === "Edit" || matchingUse.toolName === "Write") && !entry.isError) {
                    return false;
                  }
                }
                return true;
              }).map((entry, idx, arr) => {
                // Render Agent tool results as assistant messages (markdown)
                const isAgentResult = entry.type === "tool_result" && (() => {
                  const matchingUse = entries.find(
                    (e) => e.type === "tool_use" && e.toolUseId === entry.toolUseId
                  );
                  return matchingUse?.toolName === "Agent";
                })();
                const isCurrentSearchMatch = searchQuery && searchMatches[currentMatchIdx]?.uuid === entry.uuid;
                const isAnySearchMatch = searchQuery && entry.text?.toLowerCase().includes(searchQuery.toLowerCase());
                const prevTimestamp = idx > 0 ? arr[idx - 1].timestamp : undefined;
                const showTs = shouldShowTimestamp(prevTimestamp, entry.timestamp);
                return (
                  <div key={entry.uuid}>
                    {showTs && entry.timestamp && (
                      <div className="text-center text-[10px] text-gray-600 py-1">
                        {formatTimestamp(entry.timestamp)}
                      </div>
                    )}
                    <div
                      id={`msg-${entry.uuid}`}
                      className={isAnySearchMatch ? (isCurrentSearchMatch ? "ring-2 ring-yellow-500/50 rounded-lg" : "ring-1 ring-yellow-500/20 rounded-lg") : ""}
                    >
                      {isAgentResult ? (
                        <AgentResultBlock entry={entry} onOpenFile={openFileInExplorer} />
                      ) : (
                        <MessageBubble
                          entry={entry}
                          onOpenFile={openFileInExplorer}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
              {/* Active tool indicator: show even when tools are hidden */}
              {activeToolEntry && <ActiveToolIndicator entry={activeToolEntry} />}
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
            {showNewMessages && (
              <button
                onClick={() => {
                  const el = chatScrollRef.current;
                  if (el) {
                    programmaticScroll.current = true;
                    el.scrollTop = el.scrollHeight;
                    requestAnimationFrame(() => {
                      programmaticScroll.current = false;
                    });
                  }
                  setShowNewMessages(false);
                }}
                className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-xs shadow-lg transition-colors cursor-pointer"
              >
                <span>&#8595;</span>
                <span>New Messages</span>
              </button>
            )}
          </div>
          </div>
        <div className={`flex-1 flex flex-col min-h-0 ${activeTab !== "diff" ? "hidden" : ""}`}>
            <DiffPanel files={diffFiles} onSendInput={sendInputToTerminal} cwd={effectiveDir || undefined} />
          </div>
        <div className={`flex-1 flex flex-col min-h-0 ${activeTab !== "commits" ? "hidden" : ""}`}>
            <CommitsPanel cwd={effectiveDir || undefined} />
          </div>
        <div className={`flex-1 flex flex-col min-h-0 ${activeTab !== "files" ? "hidden" : ""}`}>
            <FileExplorer requestedPath={fileToOpen} onSendInput={sendInputToTerminal} cwd={effectiveDir || undefined} changedPaths={diffFiles.map(f => f.path)} refreshTrigger={fileRefreshTrigger} />
          </div>
      </div>

      {/* Vertical drag handle */}
      <div
        onMouseDown={onVDragStart}
        className="h-1 bg-gray-800 hover:bg-blue-600 cursor-row-resize flex-shrink-0 transition-colors"
      />

      {/* Terminal (bottom) */}
      <div style={{ height: `${100 - splitPct}%` }} className="min-h-0 relative">
        <div ref={containerRef} className={`h-full ${textareaMode ? "invisible" : ""}`} />
        {textareaMode && (
          <div className="absolute inset-0 flex flex-col" style={{ background: "#0a0a0f" }}>
            <div className="flex items-center justify-between px-2 py-1 text-xs text-gray-400 border-b border-gray-700 shrink-0">
              <span>Textarea Mode — <kbd className="bg-gray-700 px-1 rounded">⌘Enter</kbd> to send, <kbd className="bg-gray-700 px-1 rounded">Esc</kbd> to cancel</span>
            </div>
            <textarea
              ref={textareaRef}
              value={textareaValue}
              onChange={(e) => setTextareaValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (editorMode) {
                    const ws = wsRef.current;
                    if (ws?.readyState === WebSocket.OPEN) {
                      const bytes = new TextEncoder().encode(textareaValue);
                      const base64 = btoa(String.fromCharCode(...bytes));
                      ws.send(JSON.stringify({ type: "editor_done", data: base64 }));
                    }
                  } else if (textareaValue) {
                    sendInputToTerminal(textareaValue);
                  }
                  setEditorMode(false);
                  setTextareaMode(false);
                  setTextareaValue("");
                  setTimeout(() => termRef.current?.focus(), 0);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  if (editorMode) {
                    const ws = wsRef.current;
                    if (ws?.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: "editor_cancel" }));
                    }
                  }
                  setEditorMode(false);
                  setTextareaMode(false);
                  setTextareaValue("");
                  setTimeout(() => termRef.current?.focus(), 0);
                }
              }}
              className="flex-1 w-full p-2 text-sm text-gray-200 resize-none outline-none"
              style={{
                background: "#0a0a0f",
                fontFamily: "Menlo, Monaco, 'Courier New', monospace",
                fontSize: 12,
              }}
              spellCheck={false}
            />
          </div>
        )}
      </div>

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

interface BashParts {
  input?: string;
  stdout?: string;
  stderr?: string;
}

function parseSlashCommand(text: string): { name: string; args: string } | null {
  const nameMatch = text.match(/<command-name>(.*?)<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>(.*?)<\/command-args>/s);
  return {
    name: nameMatch[1],
    args: argsMatch?.[1]?.trim() ?? "",
  };
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

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24 && date.getDate() === now.getDate()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Returns true if this user entry is a local !command execution, not a real user prompt. */
function shouldShowTimestamp(prev: string | undefined, curr: string | undefined): boolean {
  if (!curr) return false;
  if (!prev) return true;
  const diff = new Date(curr).getTime() - new Date(prev).getTime();
  return diff > 5 * 60 * 1000; // 5 minutes
}

function MessageBubble({ entry, onOpenFile }: { entry: ConversationEntry; onOpenFile?: (path: string) => void }) {
  if (entry.type === "tool_use" && entry.toolName === "ExitPlanMode") {
    return <ExitPlanModeBlock entry={entry} />;
  }

  if (entry.type === "tool_use") {
    return <ToolUseBlock entry={entry} />;
  }

  if (entry.type === "tool_result" && entry.imageData) {
    return (
      <div className="my-1">
        <img
          src={`data:${entry.imageMediaType};base64,${entry.imageData}`}
          alt="Screenshot"
          className="rounded-lg border border-gray-700 max-w-full max-h-96 cursor-pointer"
          onClick={(e) => {
            const img = e.currentTarget;
            img.classList.toggle("max-h-96");
          }}
        />
      </div>
    );
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

    const slashCmd = parseSlashCommand(entry.text);
    if (slashCmd) {
      return (
        <div className="flex justify-start">
          <div className="inline-flex items-center gap-1 rounded-full bg-gray-800 border border-gray-700 px-3 py-1 text-xs text-gray-400">
            <span className="font-mono">{slashCmd.name}</span>
            {slashCmd.args && <span className="text-gray-500">{slashCmd.args}</span>}
          </div>
        </div>
      );
    }

    // Skip local-command-caveat entries
    if (entry.text.startsWith("<local-command-caveat>")) return null;

    // Skip meta markers like [Request interrupted by user]
    if (/^\[.*\]$/.test(entry.text.trim())) return null;

    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl bg-blue-900/40 border border-blue-800/50 px-3 py-1.5 text-sm
          prose prose-invert prose-sm
          prose-headings:text-gray-100 prose-headings:mt-3 prose-headings:mb-1
          prose-p:text-gray-100 prose-p:leading-relaxed prose-p:my-1
          prose-li:text-gray-100 prose-li:my-0
          prose-code:text-blue-300 prose-code:bg-gray-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
          prose-pre:bg-gray-900 prose-pre:border prose-pre:border-gray-700 prose-pre:rounded-lg prose-pre:my-2
          prose-a:text-blue-400
          prose-strong:text-gray-100
        ">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              a: ({ children, href, ...props }) => (
                <a
                  {...props}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (href) {
                      e.preventDefault();
                      window.open(href, "_blank", "noopener,noreferrer");
                    }
                  }}
                >
                  {children}
                </a>
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
                if (className?.includes("language-mermaid")) {
                  const chart = typeof children === "string" ? children : String(children ?? "");
                  return <MermaidBlock chart={chart.trim()} />;
                }
                if (className) {
                  return <code className={className} {...props}>{children}</code>;
                }
                const text = typeof children === "string" ? children : String(children ?? "");
                if (onOpenFile && isFilePath(text)) {
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
            a: ({ children, href, ...props }) => (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.stopPropagation();
                  if (href) {
                    e.preventDefault();
                    window.open(href, "_blank", "noopener,noreferrer");
                  }
                }}
              >
                {children}
              </a>
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
              // Render mermaid diagrams
              if (className?.includes("language-mermaid")) {
                const chart = typeof children === "string" ? children : String(children ?? "");
                return <MermaidBlock chart={chart.trim()} />;
              }
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

function AgentResultBlock({ entry, onOpenFile }: { entry: ConversationEntry; onOpenFile?: (path: string) => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number>(0);
  const [expanded, setExpanded] = useState(false);
  const COLLAPSE_THRESHOLD = 200;

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const e of entries) {
        setContentHeight(e.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const needsAccordion = contentHeight >= COLLAPSE_THRESHOLD;

  return (
    <div className="my-1">
      <div className="rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-2">
        <div className="flex items-center gap-2 text-xs mb-2">
          <span className="text-green-400 font-medium">Agent</span>
        </div>
        <div className="relative">
          <div
            className={needsAccordion && !expanded ? "overflow-hidden" : ""}
            style={needsAccordion && !expanded ? { maxHeight: `${COLLAPSE_THRESHOLD}px` } : undefined}
          >
            <div ref={contentRef}>
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
                    a: ({ children, href, ...props }) => (
                      <a
                        {...props}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (href) {
                            e.preventDefault();
                            window.open(href, "_blank", "noopener,noreferrer");
                          }
                        }}
                      >
                        {children}
                      </a>
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
                      if (className?.includes("language-mermaid")) {
                        const chart = typeof children === "string" ? children : String(children ?? "");
                        return <MermaidBlock chart={chart.trim()} />;
                      }
                      if (className) {
                        return <code className={className} {...props}>{children}</code>;
                      }
                      const text = typeof children === "string" ? children : String(children ?? "");
                      if (onOpenFile && isFilePath(text)) {
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
          </div>
          {needsAccordion && !expanded && (
            <div
              className="absolute bottom-0 left-0 right-0 h-16 pointer-events-none"
              style={{
                background: "linear-gradient(to bottom, transparent, rgba(31, 41, 55, 0.6))",
              }}
            />
          )}
        </div>
        {needsAccordion && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}

function ExitPlanModeBlock({ entry }: { entry: ConversationEntry }) {
  let parsedInput: Record<string, unknown> | null = null;
  try {
    parsedInput = JSON.parse(entry.toolInput ?? "{}");
  } catch {}

  const plan = typeof parsedInput?.plan === "string" ? parsedInput.plan : "";

  return (
    <div className="my-1">
      <div className="rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-2">
        <div className="flex items-center gap-2 text-xs mb-2">
          <span className="text-blue-400 font-medium">Plan</span>
        </div>
        {plan && (
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
            >
              {plan}
            </ReactMarkdown>
          </div>
        )}
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

function ActiveToolIndicator({ entry }: { entry: ConversationEntry }) {
  const summary = toolUseSummary(entry.toolName ?? "", entry.toolInput ?? "");
  return (
    <div className="my-1">
      <div className="w-full text-left rounded-lg bg-gray-800/60 border border-gray-700/50 px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          <svg className="animate-spin h-3 w-3 text-gray-500 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-green-400 font-medium">{entry.toolName ?? "unknown"}</span>
          <span className="text-gray-400 truncate">{summary}</span>
        </div>
      </div>
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

function TaskOverlay({ tasks, searchOpen }: { tasks: TaskItem[]; searchOpen: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const scheduledIds = useRef<Set<string>>(new Set());

  // Reset hidden/fading state when tasks are cleared (e.g. /clear, /new)
  useEffect(() => {
    if (tasks.length === 0) {
      setFadingIds(new Set());
      setHiddenIds(new Set());
      scheduledIds.current.clear();
    }
  }, [tasks.length]);

  // Schedule fade-out for newly completed tasks
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const task of tasks) {
      if (task.status === "completed" && !scheduledIds.current.has(task.taskId)) {
        scheduledIds.current.add(task.taskId);
        const t1 = setTimeout(() => {
          setFadingIds((prev) => new Set([...prev, task.taskId]));
        }, 3000);
        const t2 = setTimeout(() => {
          setHiddenIds((prev) => new Set([...prev, task.taskId]));
        }, 3500);
        timers.push(t1, t2);
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [tasks]);

  const visibleTasks = tasks.filter((t) => !hiddenIds.has(t.taskId));

  if (visibleTasks.length === 0) return null;

  return (
    <div className={`absolute ${searchOpen ? "top-[5.5rem]" : "top-10"} right-2 z-10 w-64 bg-gray-900/95 border border-gray-700 rounded-lg shadow-lg backdrop-blur-sm overflow-hidden`}>
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
          {visibleTasks.map((task) => (
            <div
              key={task.taskId}
              className={`px-3 py-1 flex items-center gap-2 text-xs transition-opacity duration-500 ${fadingIds.has(task.taskId) ? "opacity-0" : "opacity-100"}`}
            >
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
