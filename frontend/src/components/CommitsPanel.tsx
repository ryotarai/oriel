import { useState, useEffect, useCallback } from "react";

interface CommitSummary {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

interface CommitDetail {
  hash: string;
  subject: string;
  body: string;
  diff: string;
}

export function CommitsPanel({ cwd }: { cwd?: string }) {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const cwdParam = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/commits${cwdParam}`)
      .then((r) => r.json())
      .then((data) => setCommits(data ?? []))
      .catch(() => {});
  }, [cwd]);

  const selectCommit = useCallback((hash: string) => {
    setSelected(hash);
    setLoading(true);
    const cwdParam = cwd ? `&cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/commits/show?hash=${encodeURIComponent(hash)}${cwdParam}`)
      .then((r) => r.json())
      .then((data) => { setDetail(data); setLoading(false); })
      .catch(() => { setDetail(null); setLoading(false); });
  }, [cwd]);

  return (
    <div className="flex flex-1 min-h-0">
      {/* Commit list (left) */}
      <div className="w-72 flex-shrink-0 border-r border-gray-800 overflow-y-auto">
        {commits.map((c) => (
          <button
            key={c.hash}
            onClick={() => selectCommit(c.hash)}
            className={`w-full text-left px-3 py-2 border-b border-gray-800/50 transition-colors ${
              selected === c.hash ? "bg-blue-900/30" : "hover:bg-gray-800/60"
            }`}
          >
            <div className="text-gray-200 text-xs truncate">{c.subject}</div>
            <div className="text-gray-500 text-[10px] mt-0.5">
              <span className="text-gray-600 font-mono">{c.hash.slice(0, 7)}</span>
              {" · "}{c.author}{" · "}{formatDate(c.date)}
            </div>
          </button>
        ))}
        {commits.length === 0 && (
          <div className="text-gray-500 text-xs p-3 text-center">No commits</div>
        )}
      </div>

      {/* Commit detail (right) */}
      <div className="flex-1 overflow-y-auto">
        {selected && loading && (
          <div className="text-gray-500 text-sm p-4">Loading...</div>
        )}
        {selected && !loading && detail && (
          <div>
            <div className="px-4 py-3 border-b border-gray-800">
              <div className="text-gray-100 text-sm font-medium">{detail.subject}</div>
              <div className="text-gray-500 text-xs mt-1 font-mono">{detail.hash.slice(0, 12)}</div>
              {detail.body && (
                <pre className="text-gray-400 text-xs mt-2 whitespace-pre-wrap">{detail.body}</pre>
              )}
            </div>
            {detail.diff && <CommitDiff diff={detail.diff} />}
          </div>
        )}
        {!selected && (
          <div className="text-gray-500 text-sm p-4 flex items-center justify-center h-full">
            Select a commit to view
          </div>
        )}
      </div>
    </div>
  );
}

function CommitDiff({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="text-xs font-mono leading-5 px-0 py-1">
      {lines.map((line, i) => {
        let className = "text-gray-400";
        if (line.startsWith("+++ ") || line.startsWith("--- ")) {
          className = "text-gray-500";
        } else if (line.startsWith("@@")) {
          className = "text-blue-400 bg-blue-900/20";
        } else if (line.startsWith("+")) {
          className = "text-green-300 bg-green-900/20";
        } else if (line.startsWith("-")) {
          className = "text-red-300 bg-red-900/20";
        } else if (line.startsWith("diff --git")) {
          return (
            <div key={i} className="text-gray-200 bg-gray-800/60 px-4 py-1 mt-2 first:mt-0 font-medium sticky top-0 z-10">
              {line.replace(/^diff --git a\/(.+) b\/.*/, "$1")}
            </div>
          );
        } else if (line.startsWith("index ")) {
          return null;
        }

        return (
          <div key={i} className={`px-4 ${className}`}>
            {line || "\u00a0"}
          </div>
        );
      })}
    </pre>
  );
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours < 1) return "just now";
    if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
    const diffDays = diffHours / 24;
    if (diffDays < 30) return `${Math.floor(diffDays)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return dateStr;
  }
}
