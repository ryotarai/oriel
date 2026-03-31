import { describe, it, expect } from "vitest";
import { detectBlocks } from "../src/terminal/PatternDetector";
import helloFinal from "../../testdata/snapshots/hello_final.json";
import markdownFinal from "../../testdata/snapshots/markdown_final.json";
import diffFinal from "../../testdata/snapshots/diff_final.json";
import type { ScreenLine } from "../src/types";

describe("detectBlocks", () => {
  it("detects welcome box in hello scenario", () => {
    const blocks = detectBlocks(helloFinal.lines as ScreenLine[]);
    const welcome = blocks.find((b) => b.type === "welcome");
    expect(welcome).toBeDefined();
    expect(welcome!.lines.length).toBeGreaterThanOrEqual(10);
  });

  it("detects user prompt in hello scenario", () => {
    const blocks = detectBlocks(helloFinal.lines as ScreenLine[]);
    const prompts = blocks.filter((b) => b.type === "user-prompt");
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0].lines[0].text).toContain("say hello");
  });

  it("detects assistant response in hello scenario", () => {
    const blocks = detectBlocks(helloFinal.lines as ScreenLine[]);
    const responses = blocks.filter((b) => b.type === "assistant-text");
    expect(responses.length).toBeGreaterThanOrEqual(1);
  });

  it("detects headings in markdown scenario", () => {
    const blocks = detectBlocks(markdownFinal.lines as ScreenLine[]);
    const headings = blocks.filter((b) => b.type === "heading");
    expect(headings.length).toBeGreaterThanOrEqual(3);
  });

  it("detects code block in markdown scenario", () => {
    const blocks = detectBlocks(markdownFinal.lines as ScreenLine[]);
    const codeBlocks = blocks.filter((b) => b.type === "code-block");
    expect(codeBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it("detects tool call in diff scenario", () => {
    const blocks = detectBlocks(diffFinal.lines as ScreenLine[]);
    const toolCalls = blocks.filter((b) => b.type === "tool-call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("detects diff lines in diff scenario", () => {
    const blocks = detectBlocks(diffFinal.lines as ScreenLine[]);
    const diffs = blocks.filter((b) => b.type === "diff");
    expect(diffs.length).toBeGreaterThanOrEqual(1);
  });

  it("detects tool result in diff scenario", () => {
    const blocks = detectBlocks(diffFinal.lines as ScreenLine[]);
    const results = blocks.filter((b) => b.type === "tool-result");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("detects separator lines", () => {
    const blocks = detectBlocks(helloFinal.lines as ScreenLine[]);
    const seps = blocks.filter((b) => b.type === "separator");
    expect(seps.length).toBeGreaterThanOrEqual(1);
  });
});
