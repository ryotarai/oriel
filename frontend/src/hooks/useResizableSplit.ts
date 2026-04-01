import { useState, useCallback, useRef } from "react";

interface UseResizableSplitOptions {
  defaultWidth: number; // px
  minWidth?: number;    // px, default 150
  maxWidthPct?: number; // % of container, default 50
}

export function useResizableSplit({ defaultWidth, minWidth = 150, maxWidthPct = 50 }: UseResizableSplitOptions) {
  const [leftWidth, setLeftWidth] = useState(defaultWidth);
  const containerRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const maxWidth = rect.width * (maxWidthPct / 100);
      const newWidth = Math.max(minWidth, Math.min(maxWidth, ev.clientX - rect.left));
      setLeftWidth(newWidth);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [minWidth, maxWidthPct]);

  return { leftWidth, containerRef, onMouseDown };
}
