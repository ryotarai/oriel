import type { ScreenLine, Span } from "../types";

interface BufferLike {
  length: number;
  getLine(y: number): LineLike | undefined | null;
}

interface LineLike {
  length: number;
  getCell(x: number): CellLike | undefined | null;
}

interface CellLike {
  getChars(): string;
  getFgColor(): number;
  getBgColor(): number;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isBold(): number;
  isItalic(): number;
  isUnderline(): number;
  isDim(): number;
}

export function extractLines(buffer: BufferLike): ScreenLine[] {
  const lines: ScreenLine[] = [];

  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;

    const spans: Span[] = [];
    let currentSpan: (Span & { _key: string }) | null = null;

    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;

      let char = cell.getChars();
      // Empty cells (from cursor movement) should be treated as spaces
      if (char === "") char = " ";

      const fg = cell.isFgDefault() ? null : cell.getFgColor();
      const bg = cell.isBgDefault() ? null : cell.getBgColor();
      const bold = !!cell.isBold();
      const italic = !!cell.isItalic();
      const underline = !!cell.isUnderline();
      const dim = !!cell.isDim();
      const key = `${fg}:${bg}:${bold}:${italic}:${underline}:${dim}`;

      if (currentSpan && currentSpan._key === key) {
        currentSpan.text += char;
      } else {
        if (currentSpan) {
          const { _key, ...span } = currentSpan;
          spans.push(span);
        }
        currentSpan = { text: char, fg, bg, bold, italic, underline, dim, _key: key };
      }
    }

    if (currentSpan) {
      const { _key, ...span } = currentSpan;
      spans.push(span);
    }

    const text = spans.map((s) => s.text).join("");
    lines.push({ lineNumber: y, text, spans });
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].text.trim() === "") {
    lines.pop();
  }

  return lines;
}
