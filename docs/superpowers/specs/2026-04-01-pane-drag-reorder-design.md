# Pane Drag Reorder Design (dnd-kit)

## Overview

Enable drag-and-drop reordering of panes (sessions) in the horizontal layout using @dnd-kit. Users drag a pane by its tab bar to move it left or right among other panes.

## Approach

Use @dnd-kit/core + @dnd-kit/sortable for drag-and-drop with smooth animations, built-in accessibility, and no stale closure issues.

## Libraries

- `@dnd-kit/core` — DnD foundation (DndContext, DragOverlay, sensors)
- `@dnd-kit/sortable` — Sortable list (SortableContext, useSortable, arrayMove)
- `@dnd-kit/utilities` — CSS.Transform utility

## Target Files

- `frontend/src/App.tsx` — Wrap panes in DndContext + SortableContext, handle onDragEnd
- `frontend/src/SessionPanel.tsx` — Apply drag handle attributes/listeners to tab bar

## Interaction Flow

1. User grabs a pane's tab bar and moves 5+ pixels (activation constraint prevents click interference)
2. dnd-kit applies CSS transforms to show the pane moving
3. Dropping reorders the `panes` array and recalculates `splits` as equal distribution

## Implementation Details

### App.tsx Changes

- Wrap pane list in `<DndContext>` with `PointerSensor` (activationConstraint: { distance: 5 })
- Wrap pane list in `<SortableContext>` with pane IDs and `horizontalListSortingStrategy`
- `onDragEnd`: use `arrayMove` on `panes`, recalculate `splits` as equal distribution
- Each PaneWithDivider becomes a sortable item via `useSortable` hook

### SessionPanel.tsx Changes

- Accept `dragHandleProps` (attributes + listeners from useSortable) as a prop
- Spread them onto the tab bar `<div>` to make it the drag handle
- Add `cursor-grab` / `active:cursor-grabbing` to tab bar

### Edge Cases

- Single pane: no other sortable items, drag has no effect
- Drop on same position: arrayMove returns same array, no-op
- Existing divider drag uses mousedown/mousemove, separate from dnd-kit's pointer sensor

## Out of Scope

- Preserving individual pane widths after reorder (resets to equal distribution)
- Persisting pane order across page reloads
