import { useState, useCallback, useRef, useEffect } from "react";
import { SettingsPage } from "./components/SettingsPage";
import { BottomTabBar } from "./components/BottomTabBar";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SessionPanel, type SessionPanelHandle } from "./SessionPanel";

interface PaneConfig {
  id: string;
  sessionId: string;
  cwd: string; // empty = process cwd
}

interface TabConfig {
  id: string;
  name: string;
  panes: PaneConfig[];
  splits: number[];
  activePaneIndex: number;
}

let tabCounter = 1;

function makeTab(name: string, cwd: string): TabConfig {
  const id = `tab-${Date.now()}-${tabCounter}`;
  tabCounter++;
  return {
    id,
    name,
    panes: [{ id: `pane-${Date.now()}`, sessionId: `session-${Date.now()}`, cwd }],
    splits: [],
    activePaneIndex: 0,
  };
}

export default function App() {
  const [tabs, setTabs] = useState<TabConfig[]>([makeTab("Tab 1", "")]);
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [showSettings, setShowSettings] = useState(false);
  const [appConfig, setAppConfig] = useState<{ swapEnterKeys: boolean }>({ swapEnterKeys: true });
  const paneRefs = useRef<Map<string, SessionPanelHandle>>(new Map());
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // Load saved state on mount
  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((data: { tabs: Array<{ id: string; name: string; position: number }>; panes: Array<{ id: string; tabId: string; sessionId: string; cwd: string; worktreeDir: string; position: number }> }) => {
        if (data.tabs && data.tabs.length > 0) {
          const loadedTabs: TabConfig[] = data.tabs
            .sort((a, b) => a.position - b.position)
            .map((t) => {
              const tabPanes = data.panes
                .filter((p) => p.tabId === t.id)
                .sort((a, b) => a.position - b.position)
                .map((p) => ({ id: p.id, sessionId: p.sessionId, cwd: p.cwd }));
              // Update tabCounter to avoid collisions
              const num = parseInt(t.name.replace("Tab ", ""), 10);
              if (!isNaN(num) && num >= tabCounter) tabCounter = num + 1;
              return {
                id: t.id,
                name: t.name,
                panes: tabPanes.length > 0 ? tabPanes : [{ id: `pane-${Date.now()}`, sessionId: `session-${Date.now()}`, cwd: "" }],
                splits: [],
                activePaneIndex: 0,
              };
            });
          setTabs(loadedTabs);
          setActiveTabId(loadedTabs[0].id);
        }
        setInitialLoadDone(true);
      })
      .catch(() => setInitialLoadDone(true));
  }, []);

  // Save state whenever tabs change (after initial load)
  const saveState = useCallback((currentTabs: TabConfig[]) => {
    const tabsPayload = currentTabs.map((t, i) => ({ id: t.id, name: t.name, position: i }));
    const panesPayload = currentTabs.flatMap((t) =>
      t.panes.map((p, i) => ({
        id: p.id,
        tabId: t.id,
        sessionId: p.sessionId,
        cwd: p.cwd,
        worktreeDir: "",
        position: i,
      }))
    );
    fetch("/api/state/save", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabs: tabsPayload, panes: panesPayload }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialLoadDone) {
      saveState(tabs);
    }
  }, [tabs, initialLoadDone, saveState]);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setAppConfig).catch(() => {});
  }, [showSettings]);

  // Cmd+Left/Right pane navigation (scoped to active tab)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

      e.preventDefault();
      const targetIndex = e.key === "ArrowLeft" ? activeTab.activePaneIndex - 1 : activeTab.activePaneIndex + 1;
      if (targetIndex < 0 || targetIndex >= activeTab.panes.length) return;

      const targetPane = activeTab.panes[targetIndex];
      const handle = paneRefs.current.get(targetPane.id);
      if (handle) {
        handle.focus();
        updateActiveTab((tab) => ({ ...tab, activePaneIndex: targetIndex }));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab]);

  // Helper to update the active tab
  const updateActiveTab = useCallback((updater: (tab: TabConfig) => TabConfig) => {
    setTabs((prev) => prev.map((t) => t.id === activeTabId ? updater(t) : t));
  }, [activeTabId]);

  const addPaneAt = useCallback((afterIndex: number) => {
    updateActiveTab((tab) => {
      const sourceCwd = tab.panes[afterIndex]?.cwd ?? "";
      const newId = `pane-${Date.now()}`;
      const newSessionId = `session-${Date.now()}`;
      const next = [...tab.panes];
      next.splice(afterIndex + 1, 0, { id: newId, sessionId: newSessionId, cwd: sourceCwd });
      const positions: number[] = [];
      for (let i = 1; i < next.length; i++) {
        positions.push((i / next.length) * 100);
      }
      return { ...tab, panes: next, splits: positions };
    });
  }, [updateActiveTab]);

  const handleCwdChange = useCallback((paneId: string, newCwd: string) => {
    updateActiveTab((tab) => ({
      ...tab,
      panes: tab.panes.map((p) => p.id === paneId ? { ...p, cwd: newCwd } : p),
    }));
  }, [updateActiveTab]);

  const removePane = useCallback((id: string) => {
    updateActiveTab((tab) => {
      if (tab.panes.length <= 1) return tab;
      const next = tab.panes.filter((p) => p.id !== id);
      const positions: number[] = [];
      for (let i = 1; i < next.length; i++) {
        positions.push((i / next.length) * 100);
      }
      return { ...tab, panes: next, splits: positions };
    });
  }, [updateActiveTab]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    updateActiveTab((tab) => {
      const oldIndex = tab.panes.findIndex((p) => p.id === active.id);
      const newIndex = tab.panes.findIndex((p) => p.id === over.id);
      const newPanes = arrayMove(tab.panes, oldIndex, newIndex);
      const oldWidths = computeWidths(tab.panes.length, tab.splits);
      const newWidths = arrayMove(oldWidths, oldIndex, newIndex);
      const newSplits: number[] = [];
      let cumulative = 0;
      for (let i = 0; i < newWidths.length - 1; i++) {
        cumulative += newWidths[i];
        newSplits.push(cumulative);
      }
      return { ...tab, panes: newPanes, splits: newSplits };
    });
  }, [updateActiveTab]);

  // Tab management
  const addTab = useCallback(() => {
    const newTab = makeTab(`Tab ${tabCounter}`, "");
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const deleteTab = useCallback((id: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next[0].id);
      }
      return next;
    });
  }, [activeTabId]);

  const renameTab = useCallback((id: string, name: string) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, name } : t));
  }, []);

  const paneWidths = computeWidths(activeTab.panes.length, activeTab.splits);

  return (
    <div className="h-screen w-screen bg-[#0a0a0f] flex flex-col overflow-hidden">
      {/* Main pane area */}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={activeTab.panes.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex-1 flex overflow-hidden relative min-h-0">
            {/* Settings button */}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="fixed bottom-10 right-2 z-20 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs px-2 py-0.5 rounded border border-gray-600"
              title="Settings"
            >
              ⚙
            </button>
            {showSettings && (
              <div className="absolute inset-0 z-30 bg-black/70 flex items-start justify-center pt-16">
                <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
                    <h2 className="text-gray-100 font-medium">Settings</h2>
                    <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-200 text-lg">×</button>
                  </div>
                  <SettingsPage />
                </div>
              </div>
            )}
            {activeTab.panes.map((pane, i) => (
              <PaneWithDivider
                key={pane.id}
                pane={pane}
                width={paneWidths[i]}
                isLast={i === activeTab.panes.length - 1}
                showClose={activeTab.panes.length > 1}
                onClose={() => removePane(pane.id)}
                onAdd={() => addPaneAt(i)}
                onDividerDrag={(posPct) => {
                  updateActiveTab((tab) => {
                    const next = [...tab.splits];
                    next[i] = Math.max(10, Math.min(90, posPct));
                    return { ...tab, splits: next };
                  });
                }}
                swapEnterKeys={appConfig.swapEnterKeys}
                onCwdChange={(newCwd) => handleCwdChange(pane.id, newCwd)}
                onRef={(handle) => {
                  if (handle) paneRefs.current.set(pane.id, handle);
                  else paneRefs.current.delete(pane.id);
                }}
                onFocus={() => updateActiveTab((tab) => ({ ...tab, activePaneIndex: i }))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Bottom tab bar */}
      <BottomTabBar
        tabs={tabs.map((t) => ({ id: t.id, name: t.name }))}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onAddTab={addTab}
        onDeleteTab={deleteTab}
        onRenameTab={renameTab}
      />
    </div>
  );
}

function computeWidths(count: number, splits: number[]): number[] {
  if (count === 1) return [100];
  const points = [0, ...splits, 100];
  const widths: number[] = [];
  for (let i = 0; i < count; i++) {
    widths.push((points[i + 1] ?? 100) - (points[i] ?? 0));
  }
  return widths;
}

interface PaneWithDividerProps {
  pane: PaneConfig;
  width: number;
  isLast: boolean;
  showClose: boolean;
  onClose: () => void;
  onAdd: () => void;
  onDividerDrag: (posPct: number) => void;
  swapEnterKeys: boolean;
  onCwdChange: (newCwd: string) => void;
  onRef: (handle: SessionPanelHandle | null) => void;
  onFocus: () => void;
}

function PaneWithDivider({ pane, width, isLast, showClose, onClose, onAdd, onDividerDrag, swapEnterKeys, onCwdChange, onRef, onFocus }: PaneWithDividerProps) {
  const sessionRef = useRef<SessionPanelHandle>(null);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pane.id });

  const style: React.CSSProperties = {
    width: `${width}%`,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      const onMove = (ev: MouseEvent) => {
        const posPct = (ev.clientX / window.innerWidth) * 100;
        onDividerDrag(posPct);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [onDividerDrag],
  );

  useEffect(() => {
    onRef(sessionRef.current);
    return () => onRef(null);
  });

  useEffect(() => {
    const el = paneContainerRef.current;
    if (!el) return;
    const handler = () => onFocus();
    el.addEventListener("focusin", handler);
    return () => el.removeEventListener("focusin", handler);
  }, [onFocus]);

  return (
    <>
      <div
        ref={(node) => { setNodeRef(node); (paneContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = node; }}
        style={style}
        className="h-full min-w-0 relative"
      >
        {/* Toolbar */}
        <div className="absolute top-1 right-1 z-10 flex gap-1">
          <button
            onClick={() => sessionRef.current?.openCwdPicker()}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
            title="Change working directory"
          >
            📁
          </button>
          <button
            onClick={() => sessionRef.current?.openResumeModal()}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
            title="Resume session"
          >
            ↻
          </button>
          <button
            onClick={onAdd}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
            title="Add pane"
          >
            +
          </button>
          {showClose && (
            <button
              onClick={onClose}
              className="bg-gray-800 hover:bg-red-800 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
              title="Close pane"
            >
              ×
            </button>
          )}
        </div>
        <SessionPanel
          ref={sessionRef}
          sessionId={pane.sessionId}
          dragHandleProps={{ ...attributes, ...listeners }}
          swapEnterKeys={swapEnterKeys}
          cwd={pane.cwd}
          onCwdChange={onCwdChange}
        />
      </div>
      {!isLast && (
        <div
          onMouseDown={onDividerMouseDown}
          className="w-1.5 bg-gray-800 hover:bg-blue-600 cursor-col-resize flex-shrink-0 transition-colors"
        />
      )}
    </>
  );
}
