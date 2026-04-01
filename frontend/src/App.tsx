import { useState, useCallback, useRef } from "react";
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

  const addPane = useCallback(() => {
    const newId = `pane-${Date.now()}`;
    const newSessionId = `session-${Date.now()}`;
    setPanes((prev) => [...prev, { id: newId, sessionId: newSessionId }]);
    // Distribute evenly
    setSplits((prev) => {
      const count = prev.length + 2; // new pane count
      const positions: number[] = [];
      for (let i = 1; i < count; i++) {
        positions.push((i / count) * 100);
      }
      return positions;
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
      const next = arrayMove(prev, oldIndex, newIndex);
      const positions: number[] = [];
      for (let i = 1; i < next.length; i++) {
        positions.push((i / next.length) * 100);
      }
      setSplits(positions);
      return next;
    });
  }, []);

  // Calculate pane widths from split positions
  const paneWidths = computeWidths(panes.length, splits);

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext items={panes.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
        <div className="h-screen w-screen bg-[#0a0a0f] flex overflow-hidden">
          {panes.map((pane, i) => (
            <PaneWithDivider
              key={pane.id}
              pane={pane}
              width={paneWidths[i]}
              isLast={i === panes.length - 1}
              showClose={panes.length > 1}
              onClose={() => removePane(pane.id)}
              onAdd={addPane}
              onDividerDrag={(posPct) => {
                setSplits((prev) => {
                  const next = [...prev];
                  next[i] = Math.max(10, Math.min(90, posPct));
                  return next;
                });
              }}
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
}

function PaneWithDivider({ pane, width, isLast, showClose, onClose, onAdd, onDividerDrag }: PaneWithDividerProps) {
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
          {isLast && (
            <button
              onClick={onAdd}
              className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded border border-gray-600"
              title="Add pane"
            >
              +
            </button>
          )}
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
