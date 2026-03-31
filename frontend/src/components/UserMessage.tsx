import type { Block } from "../types";

export function UserMessage({ block }: { block: Block }) {
  return (
    <div className="my-3 flex justify-end px-4">
      <div className="max-w-2xl rounded-2xl bg-blue-900/40 border border-blue-800/50 px-4 py-2 text-gray-100">
        {block.content ?? block.lines[0]?.text.replace(/^❯\s*/, "")}
      </div>
    </div>
  );
}
