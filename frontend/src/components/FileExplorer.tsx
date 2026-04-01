import { useState, useEffect, useCallback } from "react";
import hljs from "highlight.js";
import { abbreviateHome } from "../utils/paths";

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

export function FileExplorer({ requestedPath, onSendInput, cwd }: { requestedPath?: string | null; onSendInput?: (text: string) => void; cwd?: string }) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [loading, setLoading] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);

  useEffect(() => {
    const poll = () => {
      const cwdParam = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      fetch(`/api/files/tree${cwdParam}`)
        .then((r) => r.json())
        .then(setTree)
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [cwd]);

  // Open file when requested externally
  useEffect(() => {
    if (requestedPath && requestedPath !== selectedPath) {
      openFile(requestedPath);
    }
  }, [requestedPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = useCallback((path: string) => {
    setSelectedPath(path);
    setLoading(true);
    const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/files/read?path=${encodeURIComponent(path)}${cwdParam}`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json();
      })
      .then((data) => {
        // Backend may resolve the path to a subdirectory match
        if (data.path && data.path !== path) {
          setSelectedPath(data.path);
        }
        setFileContent(data.content);
        setIsBinary(data.isBinary ?? false);
        setLoading(false);
      })
      .catch(() => {
        setFileContent("Failed to load file");
        setLoading(false);
      });
  }, [cwd]);

  return (
    <div className="flex flex-col h-full min-h-0">
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
      <div className="flex flex-1 min-h-0">
        {/* File tree (left pane) */}
        <div className="w-64 flex-shrink-0 border-r border-gray-700 overflow-y-auto text-sm">
          {tree ? (
            <div className="py-1">
              {tree.children?.map((node) => (
                <TreeItem
                  key={node.path || node.name}
                  node={node}
                  depth={0}
                  selectedPath={selectedPath}
                  onSelect={openFile}
                />
              ))}
            </div>
          ) : (
            <div className="text-gray-500 text-xs p-3">Loading...</div>
          )}
        </div>

        {/* File viewer (right pane) */}
        <div className="flex-1 overflow-auto min-w-0">
          {selectedPath ? (
            loading ? (
              <div className="text-gray-500 text-sm p-4">Loading...</div>
            ) : (
              <div className="flex flex-col h-full">
                <div className="flex-shrink-0 px-3 py-1.5 text-xs text-gray-400 border-b border-gray-700 bg-gray-900/50">
                  {selectedPath}
                </div>
                <div className="flex-1 overflow-auto">
                  {isBinary ? (
                    <div className="text-gray-500 text-sm p-4 flex items-center justify-center h-full">
                      Binary file
                    </div>
                  ) : (
                    <HighlightedCode content={fileContent ?? ""} path={selectedPath} onSendInput={onSendInput} wrapLines={wrapLines} />
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="text-gray-500 text-sm p-4 flex items-center justify-center h-full">
              Select a file to view
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (node.isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full text-left px-2 py-0.5 hover:bg-gray-800 text-gray-300 flex items-center gap-1 truncate"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span className="text-gray-500 text-xs w-4 flex-shrink-0">
            {expanded ? "▼" : "▶"}
          </span>
          <span className="text-yellow-400/70 flex-shrink-0">📁</span>
          <span className="truncate">{node.name}</span>
        </button>
        {expanded &&
          node.children?.map((child) => (
            <TreeItem
              key={child.path || child.name}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
      </div>
    );
  }

  const isSelected = selectedPath === node.path;
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`w-full text-left px-2 py-0.5 flex items-center gap-1 truncate ${
        isSelected
          ? "bg-blue-900/40 text-blue-200"
          : "hover:bg-gray-800 text-gray-400"
      }`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <span className="w-4 flex-shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function extensionToLanguage(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    go: "go",
    py: "python",
    rs: "rust",
    rb: "ruby",
    java: "java",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    css: "css",
    html: "html",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    toml: "toml",
    xml: "xml",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    swift: "swift",
    kt: "kotlin",
    lua: "lua",
    r: "r",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };
  if (ext) return map[ext];
  const name = path.split("/").pop()?.toLowerCase();
  if (name === "makefile") return "makefile";
  if (name === "dockerfile") return "dockerfile";
  return undefined;
}

function HighlightedCode({ content, path, onSendInput, wrapLines }: { content: string; path: string; onSendInput?: (text: string) => void; wrapLines: boolean }) {
  const lang = extensionToLanguage(path);
  let html: string;

  try {
    if (lang && hljs.getLanguage(lang)) {
      html = hljs.highlight(content, { language: lang }).value;
    } else {
      html = hljs.highlightAuto(content).value;
    }
  } catch {
    html = escapeHtml(content);
  }

  // Split highlighted HTML into lines, preserving open span tags across line breaks
  const htmlLines = splitHtmlByLines(html);
  const rawLines = content.split("\n");

  return (
    <pre className={`text-xs font-mono py-3 leading-relaxed text-gray-200 ${wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
      {htmlLines.map((lineHtml, i) => (
        <LineWithButton
          key={i}
          lineHtml={lineHtml}
          rawText={rawLines[i] ?? ""}
          filePath={path}
          lineNumber={i + 1}
          onSendInput={onSendInput}
        />
      ))}
    </pre>
  );
}

function splitHtmlByLines(html: string): string[] {
  // Split HTML on newlines while carrying open <span> tags across lines
  const lines: string[] = [];
  let current = "";
  let openTags: string[] = []; // stack of open <span ...> strings

  let i = 0;
  while (i < html.length) {
    if (html[i] === "\n") {
      lines.push(current);
      current = openTags.join("");
      i++;
    } else if (html[i] === "<") {
      const closeMatch = html.slice(i).match(/^<\/span>/);
      if (closeMatch) {
        current += closeMatch[0];
        openTags.pop();
        i += closeMatch[0].length;
      } else {
        const openMatch = html.slice(i).match(/^<span[^>]*>/);
        if (openMatch) {
          current += openMatch[0];
          openTags.push(openMatch[0]);
          i += openMatch[0].length;
        } else {
          current += html[i];
          i++;
        }
      }
    } else {
      current += html[i];
      i++;
    }
  }
  lines.push(current);
  return lines;
}

function LineWithButton({ lineHtml, rawText, filePath, lineNumber, onSendInput }: {
  lineHtml: string;
  rawText: string;
  filePath: string;
  lineNumber: number;
  onSendInput?: (text: string) => void;
}) {
  return (
    <div className="group flex hover:bg-gray-800/40">
      <div className="w-8 flex-shrink-0 flex items-center justify-center">
        {onSendInput && (
          <button
            onClick={() => {
              onSendInput(`@${filePath}:${lineNumber}\n\`\`\`\n${rawText}\n\`\`\`\n`);
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
      <code className="flex-1 px-1" dangerouslySetInnerHTML={{ __html: lineHtml || "\u00a0" }} />
    </div>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
