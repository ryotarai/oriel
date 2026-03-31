import { useState } from "react";
import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

export function ToolCallCard({ block }: { block: Block }) {
  const [expanded, setExpanded] = useState(true);
  const tool = (block.meta?.tool as string) ?? "Tool";
  const args = (block.meta?.args as string) ?? "";

  return (
    <div className="my-2 mx-4 rounded-lg border border-gray-700 bg-gray-900/70">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-800/50"
      >
        <span className="text-green-400">●</span>
        <span className="font-bold text-gray-200">{tool}</span>
        <span className="text-gray-500">({args})</span>
        <span className="ml-auto text-gray-600">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && block.lines.length > 1 && (
        <div className="border-t border-gray-800 px-3 py-2">
          <TerminalFallback lines={block.lines.slice(1)} />
        </div>
      )}
    </div>
  );
}
