import { useRef, useCallback, useState } from "react";
import { abbreviateHome } from "../utils/paths";
import { useResizableSplit } from "../hooks/useResizableSplit";

export interface FileDiffData {
  path: string;
  status: string; // "M", "A", "D"
  diff: string | null;
}

interface DiffPanelProps {
  files: FileDiffData[];
  onSendInput?: (text: string) => void;
  cwd?: string;
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

export function DiffPanel({ files, onSendInput, cwd }: DiffPanelProps) {
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [wrapLines, setWrapLines] = useState(true);
  const { leftWidth, containerRef: splitContainerRef, onMouseDown: onSplitMouseDown } = useResizableSplit({ defaultWidth: 240 });

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
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center px-3 py-1 border-b border-gray-800">
        <label className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={wrapLines}
            onChange={(e) => setWrapLines(e.target.checked)}
            className="accent-blue-500"
          />
          Wrap lines
        </label>
        {cwd && (
          <span className="ml-auto text-[10px] text-gray-600 font-mono truncate max-w-[50%]" title={cwd}>
            {abbreviateHome(cwd)}
          </span>
        )}
      </div>
      <div ref={splitContainerRef} className="flex flex-1 min-h-0">
        {/* File tree (left) */}
        <div className="flex-shrink-0 border-r border-gray-800 overflow-y-auto" style={{ width: leftWidth }}>
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

        {/* Resize handle */}
        <div
          onMouseDown={onSplitMouseDown}
          className="w-1 flex-shrink-0 cursor-col-resize hover:bg-blue-600 transition-colors"
        />

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
                <a
                  href={`vscode://file${f.path.startsWith("/") ? f.path : `/${cwd || ""}/${f.path}`}`}
                  className="ml-auto text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded border border-gray-700 hover:border-gray-600 inline-flex items-center"
                  title="Open in VS Code"
                >
                  <svg width="12" height="12" viewBox="0 0 100 100" fill="currentColor">
                    <path d="M70.8 6.8L29.3 42.5 12.7 29.8 4.5 33.5v33l8.2 3.7 16.6-12.7L70.8 93.2 95.5 82V18L70.8 6.8zM29.3 61.5l-12.5 9.5V29l12.5 9.5v23zm41.5 14.3L49.5 58.5l21.3-17.3v34.6z"/>
                  </svg>
                </a>
              </div>
              {/* Diff content */}
              {f.diff ? (
                <DiffBlock diff={f.diff} filePath={f.path} onSendInput={onSendInput} wrapLines={wrapLines} />
              ) : (
                <div className="px-4 py-3 text-gray-500 text-xs italic">Binary file</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DiffBlock({ diff, filePath, onSendInput, wrapLines }: { diff: string; filePath: string; onSendInput?: (text: string) => void; wrapLines: boolean }) {
  const lines = diff.split("\n");

  // Track line numbers from @@ hunk headers
  let oldLine = 0;
  let newLine = 0;

  return (
    <pre className={`text-xs font-mono leading-5 px-0 py-1 ${wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
      {lines.map((line, i) => {
        let className = "";
        let lineNumber: number | null = null;

        if (line.startsWith("+++ ") || line.startsWith("--- ")) {
          className += "text-gray-500";
        } else if (line.startsWith("@@")) {
          className += "text-blue-400 bg-blue-900/20";
          const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (match) {
            oldLine = parseInt(match[1], 10);
            newLine = parseInt(match[2], 10);
          }
        } else if (line.startsWith("+")) {
          className += "text-green-300 bg-green-900/20";
          lineNumber = newLine;
          newLine++;
        } else if (line.startsWith("-")) {
          className += "text-red-300 bg-red-900/20";
          oldLine++;
        } else if (line.startsWith("diff --git")) {
          return null; // skip diff header lines
        } else if (line.startsWith("index ")) {
          return null; // skip index lines
        } else {
          className += "text-gray-400";
          lineNumber = newLine;
          oldLine++;
          newLine++;
        }

        const ref = lineNumber != null ? `@${filePath}:${lineNumber}` : `@${filePath}`;

        return (
          <div key={i} className={`group flex ${className}`}>
            <div className="w-8 flex-shrink-0 flex items-center justify-center">
              {onSendInput && (
                <button
                  onClick={() => {
                    onSendInput(`${ref}\n\`\`\`\n${line}\n\`\`\`\n`);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 transition-opacity p-0.5"
                  title="Send line to Claude"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 14L2 14L2 2L10 2" />
                    <path d="M5 8L14 8" />
                    <path d="M11 5L14 8L11 11" />
                  </svg>
                </button>
              )}
            </div>
            <span className="flex-1 pr-4">{line || "\u00a0"}</span>
          </div>
        );
      })}
    </pre>
  );
}
