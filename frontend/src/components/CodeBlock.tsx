import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

export function CodeBlock({ block }: { block: Block }) {
  return (
    <div className="my-3 mx-4 rounded-lg border border-gray-700 bg-gray-900 overflow-x-auto">
      <div className="p-4">
        <TerminalFallback lines={block.lines} />
      </div>
    </div>
  );
}
