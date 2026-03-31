import pkg from "@xterm/headless";
const { Terminal } = pkg;
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { basename, join } from "path";

const COLS = 120;
const ROWS = 40;

function extractBuffer(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];

  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;

    const spans = [];
    let currentSpan = null;

    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;

      const char = cell.getChars();
      if (char === "" && x > 0) continue; // wide char continuation

      const attrs = {
        fg: cell.isFgDefault() ? null : cell.getFgColor(),
        bg: cell.isBgDefault() ? null : cell.getBgColor(),
        bold: !!(cell.isBold()),
        italic: !!(cell.isItalic()),
        underline: !!(cell.isUnderline()),
        dim: !!(cell.isDim()),
      };

      const attrKey = JSON.stringify(attrs);

      if (currentSpan && currentSpan._attrKey === attrKey) {
        currentSpan.text += char;
      } else {
        if (currentSpan) {
          delete currentSpan._attrKey;
          spans.push(currentSpan);
        }
        currentSpan = { text: char, ...attrs, _attrKey: attrKey };
      }
    }

    if (currentSpan) {
      delete currentSpan._attrKey;
      spans.push(currentSpan);
    }

    // Skip completely empty lines at the end
    const lineText = spans.map((s) => s.text).join("");
    lines.push({
      lineNumber: y,
      text: lineText,
      spans,
    });
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].text.trim() === "") {
    lines.pop();
  }

  return lines;
}

function processRawFile(rawPath, outDir) {
  const rawData = readFileSync(rawPath);
  const name = basename(rawPath, ".raw");

  const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

  // Feed the raw data into the terminal in chunks to simulate streaming
  // We'll take snapshots at key points

  const snapshots = [];

  // Feed all data and take final snapshot
  terminal.write(rawData, () => {
    const lines = extractBuffer(terminal);
    snapshots.push({
      name: `${name}_final`,
      description: `Final screen state after all output`,
      cols: COLS,
      rows: ROWS,
      lines,
    });

    const outPath = join(outDir, `${name}_final.json`);
    writeFileSync(outPath, JSON.stringify(snapshots[0], null, 2));
    console.log(`Written: ${outPath} (${lines.length} lines)`);
  });

  // Also create incremental snapshots by splitting the raw data
  // into chunks and snapshotting at intervals
  const chunkSize = Math.floor(rawData.length / 5);
  for (let i = 1; i <= 4; i++) {
    const partialData = rawData.subarray(0, chunkSize * i);
    const partialTerminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

    const idx = i;
    partialTerminal.write(partialData, () => {
      const lines = extractBuffer(partialTerminal);
      const snapshot = {
        name: `${name}_part${idx}`,
        description: `Screen state at ~${idx * 20}% of output`,
        cols: COLS,
        rows: ROWS,
        lines,
      };

      const outPath = join(outDir, `${name}_part${idx}.json`);
      writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
      console.log(`Written: ${outPath} (${lines.length} lines)`);
    });
  }
}

// Main
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node extract.mjs <raw-file-or-dir> <output-dir>");
  process.exit(1);
}

const [input, outDir] = args;
mkdirSync(outDir, { recursive: true });

import { readdirSync, statSync } from "fs";

const stat = statSync(input);
if (stat.isDirectory()) {
  const files = readdirSync(input).filter((f) => f.endsWith(".raw"));
  for (const file of files) {
    processRawFile(join(input, file), outDir);
  }
} else {
  processRawFile(input, outDir);
}
