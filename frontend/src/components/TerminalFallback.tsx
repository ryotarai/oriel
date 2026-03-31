import type { ScreenLine, Span } from "../types";

const COLORS_16: Record<number, string> = {
  0: "#000", 1: "#c00", 2: "#0a0", 3: "#aa0", 4: "#55f",
  5: "#a0a", 6: "#0aa", 7: "#aaa", 8: "#555", 9: "#f55",
  10: "#5f5", 11: "#ff5", 12: "#55f", 13: "#f5f", 14: "#5ff", 15: "#fff",
};

function fgColor(fg: number): string {
  if (fg < 16) return COLORS_16[fg] ?? "#aaa";
  if (fg < 232) {
    const n = fg - 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor((n % 36) / 6) * 51;
    const b = (n % 6) * 51;
    return `rgb(${r},${g},${b})`;
  }
  const v = (fg - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

function spanStyle(span: Span): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (span.fg !== null) style.color = fgColor(span.fg);
  if (span.bg !== null) style.backgroundColor = fgColor(span.bg);
  if (span.bold) style.fontWeight = "bold";
  if (span.italic) style.fontStyle = "italic";
  if (span.underline) style.textDecoration = "underline";
  if (span.dim) style.opacity = 0.5;
  return style;
}

export function TerminalFallback({ lines }: { lines: ScreenLine[] }) {
  return (
    <pre className="font-mono text-sm leading-5 whitespace-pre">
      {lines.map((line) => (
        <div key={line.lineNumber}>
          {line.spans.map((span, i) => (
            <span key={i} style={spanStyle(span)}>
              {span.text}
            </span>
          ))}
        </div>
      ))}
    </pre>
  );
}
