import { useState, useRef, useEffect, useCallback } from "react";

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
}

export function BottomTabBar({ tabs, activeTabId, onSelectTab, onAddTab, onDeleteTab, onRenameTab }: BottomTabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="flex items-center bg-gray-900 border-t border-gray-700 h-8 px-1 gap-0.5 flex-shrink-0">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelectTab(tab.id)}
          onDoubleClick={() => startRename(tab.id, tab.name)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ id: tab.id, x: e.clientX, y: e.clientY });
          }}
          className={`px-3 py-1 text-xs rounded-t transition-colors truncate max-w-[150px] ${
            tab.id === activeTabId
              ? "bg-gray-800 text-gray-100 border-t border-x border-gray-600"
              : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
          }`}
        >
          {editingId === tab.id ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
              className="bg-transparent border-none outline-none text-xs w-full text-gray-100"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            tab.name
          )}
        </button>
      ))}
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
