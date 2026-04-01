import { useState, useCallback, useRef, useEffect } from "react";
import { SettingsPage } from "./components/SettingsPage";
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
}

export default function App() {
  const [panes, setPanes] = useState<PaneConfig[]>([
    { id: "pane-1", sessionId: "session-1" },
  ]);
  // Split positions between panes (percentage of total width for each divider)
  const [splits, setSplits] = useState<number[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [appConfig, setAppConfig] = useState<{ swapEnterKeys: boolean }>({ swapEnterKeys: true });

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setAppConfig).catch(() => {});
  }, [showSettings]); // Re-fetch when settings modal closes

  const addPaneAt = useCallback((afterIndex: number) => {
    const newId = `pane-${Date.now()}`;
    const newSessionId = `session-${Date.now()}`;
    setPanes((prev) => {
      const next = [...prev];
      next.splice(afterIndex + 1, 0, { id: newId, sessionId: newSessionId });
      const positions: number[] = [];
      for (let i = 1; i < next.length; i++) {
        positions.push((i / next.length) * 100);
      }
      setSplits(positions);
      return next;
    });
  }, []);

  const removePane = useCallback((id: string) => {
    setPanes((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((p) => p.id !== id);
      // Recalculate splits
      const positions: number[] = [];
      for (let i = 1; i < next.length; i++) {
        positions.push((i / next.length) * 100);
      }
      setSplits(positions);
      return next;
    });
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setPanes((prev) => {
      const oldIndex = prev.findIndex((p) => p.id === active.id);
      const newIndex = prev.findIndex((p) => p.id === over.id);
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Calculate pane widths from split positions
  const paneWidths = computeWidths(panes.length, splits);

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext items={panes.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
        <div className="h-screen w-screen bg-[#0a0a0f] flex overflow-hidden relative">
          {/* Settings button */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="absolute top-1 left-1 z-20 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs px-2 py-0.5 rounded border border-gray-600"
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
          {panes.map((pane, i) => (
            <PaneWithDivider
              key={pane.id}
              pane={pane}
              width={paneWidths[i]}
              isLast={i === panes.length - 1}
              showClose={panes.length > 1}
              onClose={() => removePane(pane.id)}
              onAdd={() => addPaneAt(i)}
              onDividerDrag={(posPct) => {
                setSplits((prev) => {
                  const next = [...prev];
                  next[i] = Math.max(10, Math.min(90, posPct));
                  return next;
                });
              }}
              swapEnterKeys={appConfig.swapEnterKeys}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
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
}

function PaneWithDivider({ pane, width, isLast, showClose, onClose, onAdd, onDividerDrag, swapEnterKeys }: PaneWithDividerProps) {
  const sessionRef = useRef<SessionPanelHandle>(null);
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

  return (
    <>
      <div ref={setNodeRef} style={style} className="h-full min-w-0 relative">
        {/* Toolbar */}
        <div className="absolute top-1 right-1 z-10 flex gap-1">
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
