import { describe, it, expect } from "vitest";
import { extractLines } from "../src/terminal/BufferReader";

describe("extractLines", () => {
  it("extracts spans with correct attributes from a mock buffer", () => {
    const mockLine = {
      length: 5,
      getCell: (x: number) => {
        if (x === 0) return mockCell("●", 231, null, false, false, false, false);
        if (x === 1) return mockCell(" ", null, null, false, false, false, false);
        if (x === 2) return mockCell("H", null, null, false, false, false, false);
        if (x === 3) return mockCell("i", null, null, false, false, false, false);
        if (x === 4) return mockCell("!", null, null, false, false, false, false);
        return null;
      },
    };

    const lines = extractLines({
      length: 1,
      getLine: (y: number) => (y === 0 ? mockLine : null),
    } as any);

    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("● Hi!");
    expect(lines[0].spans[0]).toMatchObject({ text: "●", fg: 231 });
    expect(lines[0].spans[1]).toMatchObject({ text: " Hi!", fg: null });
  });
});

function mockCell(char: string, fg: number | null, bg: number | null, bold: boolean, italic: boolean, underline: boolean, dim: boolean) {
  return {
    getChars: () => char,
    getFgColor: () => fg ?? 0,
    getBgColor: () => bg ?? 0,
    isFgDefault: () => fg === null,
    isBgDefault: () => bg === null,
    isBold: () => bold ? 1 : 0,
    isItalic: () => italic ? 1 : 0,
    isUnderline: () => underline ? 1 : 0,
    isDim: () => dim ? 1 : 0,
  };
}
