import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

export function StatusBar({ block }: { block: Block }) {
  return (
    <div className="px-4 py-1 text-xs text-gray-500">
      <TerminalFallback lines={block.lines} />
    </div>
  );
}
