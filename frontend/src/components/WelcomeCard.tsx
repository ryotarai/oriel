import type { Block } from "../types";
import { TerminalFallback } from "./TerminalFallback";

export function WelcomeCard({ block }: { block: Block }) {
  return (
    <div className="mx-auto max-w-3xl my-4 rounded-lg border border-pink-900/50 bg-gray-900/50 p-4">
      <TerminalFallback lines={block.lines} />
    </div>
  );
}
