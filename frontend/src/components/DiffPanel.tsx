import { useRef, useCallback } from "react";

export interface FileDiffData {
  path: string;
  status: string; // "M", "A", "D"
  diff: string | null;
}

interface DiffPanelProps {
  files: FileDiffData[];
}

function statusColor(status: string): string {
  switch (status) {
    case "A": return "text-green-400";
    case "D": return "text-red-400";
    case "M": return "text-yellow-400";
    default:  return "text-gray-400";
  }
}

function statusBgColor(status: string): string {
  switch (status) {
    case "A": return "bg-green-900/40 text-green-400";
    case "D": return "bg-red-900/40 text-red-400";
    case "M": return "bg-yellow-900/40 text-yellow-400";
    default:  return "bg-gray-800 text-gray-400";
  }
}

export function DiffPanel({ files }: DiffPanelProps) {
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const scrollToFile = useCallback((path: string) => {
    const el = sectionRefs.current.get(path);
    if (el && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: el.offsetTop - scrollContainerRef.current.offsetTop,
        behavior: "smooth",
      });
    }
  }, []);

  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        No changes yet
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* File tree (left) */}
      <div className="w-60 flex-shrink-0 border-r border-gray-800 overflow-y-auto">
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => scrollToFile(f.path)}
            className="w-full text-left px-3 py-1.5 hover:bg-gray-800/60 text-xs font-mono flex items-center gap-2 transition-colors"
          >
            <span className={`font-bold flex-shrink-0 w-4 text-center ${statusColor(f.status)}`}>
              {f.status}
            </span>
            <span className="text-gray-500 truncate">
              {f.path.includes("/") ? f.path.substring(0, f.path.lastIndexOf("/") + 1) : ""}
              <span className="text-gray-200">
                {f.path.includes("/") ? f.path.substring(f.path.lastIndexOf("/") + 1) : f.path}
              </span>
            </span>
          </button>
        ))}
      </div>

      {/* Diff sections (right) */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {files.map((f) => (
          <div
            key={f.path}
            ref={(el) => { if (el) sectionRefs.current.set(f.path, el); }}
          >
            {/* File header */}
            <div className="sticky top-0 z-10 bg-gray-900/95 backdrop-blur-sm border-b border-gray-800 px-4 py-2 flex items-center gap-2">
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${statusBgColor(f.status)}`}>
                {f.status}
              </span>
              <span className="text-sm font-mono text-gray-200">{f.path}</span>
            </div>
            {/* Diff content */}
            {f.diff ? (
              <DiffBlock diff={f.diff} />
            ) : (
              <div className="px-4 py-3 text-gray-500 text-xs italic">Binary file</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="text-xs font-mono leading-5 px-0 py-1">
      {lines.map((line, i) => {
        let className = "px-4 ";
        if (line.startsWith("+++ ") || line.startsWith("--- ")) {
          className += "text-gray-500";
        } else if (line.startsWith("@@")) {
          className += "text-blue-400 bg-blue-900/20";
        } else if (line.startsWith("+")) {
          className += "text-green-300 bg-green-900/20";
        } else if (line.startsWith("-")) {
          className += "text-red-300 bg-red-900/20";
        } else if (line.startsWith("diff --git")) {
          return null; // skip diff header lines
        } else if (line.startsWith("index ")) {
          return null; // skip index lines
        } else {
          className += "text-gray-400";
        }

        return (
          <div key={i} className={className}>
            {line || "\u00a0"}
          </div>
        );
      })}
    </pre>
  );
}
