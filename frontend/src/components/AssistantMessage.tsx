import type { Block } from "../types";

export function AssistantMessage({ block }: { block: Block }) {
  return (
    <div className="my-1 px-4 text-gray-200 leading-relaxed">
      {block.content ?? block.lines.map(l => l.text).join(" ")}
    </div>
  );
}
