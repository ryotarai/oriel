import type { Block } from "../types";

export function SpinnerIndicator({ block }: { block: Block }) {
  const text = block.lines[0]?.spans
    .filter(s => s.fg === 216 || s.fg === 174)
    .map(s => s.text)
    .join("") ?? "Thinking…";

  return (
    <div className="my-2 px-4 flex items-center gap-2 text-pink-300">
      <span className="animate-spin inline-block w-4 h-4 border-2 border-pink-400 border-t-transparent rounded-full" />
      <span className="text-sm">{text}</span>
    </div>
  );
}
