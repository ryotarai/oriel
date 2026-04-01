# Pane Drag Reorder Implementation Plan (dnd-kit)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable drag-and-drop reordering of session panes by dragging their tab bar, using @dnd-kit.

**Architecture:** Wrap the pane list in `DndContext` + `SortableContext` in `App.tsx`. Each `PaneWithDivider` uses `useSortable` to become a sortable item. The tab bar in `SessionPanel.tsx` receives drag handle props. `onDragEnd` reorders the `panes` array via `arrayMove`.

**Tech Stack:** React 19, @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities, TypeScript, Tailwind CSS

---

### Task 1: Install dnd-kit packages

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Install packages**

```bash
cd frontend && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

- [ ] **Step 2: Verify build still passes**

Run: `cd frontend && npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "Add dnd-kit dependencies for pane reordering"
```

---

### Task 2: Add DndContext and SortableContext to App.tsx, make PaneWithDivider sortable

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add imports**

Add at top of `App.tsx`:

```typescript
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
```

- [ ] **Step 2: Add sensor and onDragEnd handler in App()**

Add inside `App()`, after `removePane`:

```typescript
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
    // Recalculate splits as equal distribution
    const positions: number[] = [];
    for (let i = 1; i < next.length; i++) {
      positions.push((i / next.length) * 100);
    }
    setSplits(positions);
    return next;
  });
}, []);
```

- [ ] **Step 3: Wrap pane list in DndContext and SortableContext**

Change the return JSX from:

```tsx
return (
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
);
```

to:

```tsx
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
```

- [ ] **Step 4: Update PaneWithDivider to use useSortable**

Replace the existing `PaneWithDivider` function with:

```typescript
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
```

- [ ] **Step 5: Verify build passes**

Run: `cd frontend && npm run build`
Expected: TypeScript error about SessionPanel's new `dragHandleProps` prop — proceed to Task 3

---

### Task 3: Make SessionPanel tab bar a drag handle

**Files:**
- Modify: `frontend/src/SessionPanel.tsx`

- [ ] **Step 1: Update SessionPanel props to accept dragHandleProps**

Change line 35 from:

```typescript
export const SessionPanel = forwardRef<SessionPanelHandle, { sessionId: string }>(function SessionPanel({ sessionId }, ref) {
```

to:

```typescript
interface SessionPanelProps {
  sessionId: string;
  dragHandleProps?: Record<string, unknown>;
}

export const SessionPanel = forwardRef<SessionPanelHandle, SessionPanelProps>(function SessionPanel({ sessionId, dragHandleProps }, ref) {
```

- [ ] **Step 2: Spread dragHandleProps onto the tab bar div**

Change the tab bar div (around line 295) from:

```tsx
<div className="flex-shrink-0 flex border-b border-gray-800 bg-gray-900/50 pr-24">
```

to:

```tsx
<div
  className="flex-shrink-0 flex border-b border-gray-800 bg-gray-900/50 pr-24 cursor-grab active:cursor-grabbing"
  {...dragHandleProps}
>
```

- [ ] **Step 3: Verify build passes**

Run: `cd frontend && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/SessionPanel.tsx
git commit -m "Add drag-and-drop pane reordering with dnd-kit"
```
