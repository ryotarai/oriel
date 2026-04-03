import { useState, useRef, useEffect, useCallback } from "react";
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
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface TabInfo {
  id: string;
  name: string;
}

interface BottomTabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onAddTab: () => void;
  onDeleteTab: (id: string) => void;
  onRenameTab: (id: string, name: string) => void;
  onReorderTabs: (activeId: string, overId: string) => void;
}

function SortableTab({
  tab,
  isActive,
  isEditing,
  editValue,
  inputRef,
  onSelect,
  onStartRename,
  onContextMenu,
  onEditChange,
  onCommitRename,
  onCancelRename,
}: {
  tab: TabInfo;
  isActive: boolean;
  isEditing: boolean;
  editValue: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: () => void;
  onStartRename: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      onDoubleClick={onStartRename}
      onContextMenu={onContextMenu}
      className={`px-3 py-1 text-xs rounded-t transition-colors truncate max-w-[150px] ${
        isActive
          ? "bg-gray-800 text-gray-100 border-t border-x border-gray-600"
          : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
      }`}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename();
            if (e.key === "Escape") onCancelRename();
          }}
          className="bg-transparent border-none outline-none text-xs w-full text-gray-100"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        tab.name
      )}
    </button>
  );
}

export function BottomTabBar({ tabs, activeTabId, onSelectTab, onAddTab, onDeleteTab, onRenameTab, onReorderTabs }: BottomTabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [contextMenu]);

  const startRename = useCallback((id: string, currentName: string) => {
    setEditingId(id);
    setEditValue(currentName);
    setContextMenu(null);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId && editValue.trim()) {
      onRenameTab(editingId, editValue.trim());
    }
    setEditingId(null);
  }, [editingId, editValue, onRenameTab]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onReorderTabs(active.id as string, over.id as string);
  }, [onReorderTabs]);

  return (
    <div className="flex items-center bg-gray-900 border-t border-gray-700 h-8 px-1 gap-0.5 flex-shrink-0">
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab) => (
            <SortableTab
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              isEditing={editingId === tab.id}
              editValue={editValue}
              inputRef={inputRef}
              onSelect={() => onSelectTab(tab.id)}
              onStartRename={() => startRename(tab.id, tab.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ id: tab.id, x: e.clientX, y: e.clientY });
              }}
              onEditChange={setEditValue}
              onCommitRename={commitRename}
              onCancelRename={() => setEditingId(null)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        onClick={onAddTab}
        className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 rounded transition-colors"
        title="New tab"
      >
        +
      </button>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-gray-800 border border-gray-600 rounded shadow-lg py-1 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y - 60 }}
        >
          <button
            onClick={() => startRename(contextMenu.id, tabs.find((t) => t.id === contextMenu.id)?.name ?? "")}
            className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700"
          >
            Rename
          </button>
          {tabs.length > 1 && (
            <button
              onClick={() => {
                if (confirm("Delete this tab? All Claude sessions in this tab will be terminated.")) {
                  onDeleteTab(contextMenu.id);
                }
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
