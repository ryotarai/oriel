import type { Block } from "../types";

export function DiffView({ block }: { block: Block }) {
  return (
    <div className="my-1 mx-4 rounded border border-gray-700 overflow-x-auto font-mono text-sm">
      {block.lines.map((line) => {
        const text = line.text.trim();
        const isAdd = line.spans.some(s => s.bg !== null && s.bg !== 237 && s.bg !== 16 && text.includes("+"));
        const isRemove = line.spans.some(s => s.bg !== null && s.bg !== 237 && s.bg !== 16 && text.includes("-"));

        let bg = "bg-transparent";
        if (isAdd) bg = "bg-green-950/50";
        if (isRemove) bg = "bg-red-950/50";

        return (
          <div key={line.lineNumber} className={`px-3 py-0.5 ${bg}`}>
            {line.spans.map((span, i) => (
              <span key={i} className={isAdd ? "text-green-300" : isRemove ? "text-red-300" : "text-gray-300"}>
                {span.text}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
