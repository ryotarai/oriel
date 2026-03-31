export interface Span {
  text: string;
  fg: number | null;
  bg: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
}

export interface ScreenLine {
  lineNumber: number;
  text: string;
  spans: Span[];
}

export type BlockType =
  | "welcome"
  | "user-prompt"
  | "spinner"
  | "assistant-text"
  | "heading"
  | "bullet-list"
  | "code-block"
  | "tool-call"
  | "tool-result"
  | "diff"
  | "separator"
  | "input-prompt"
  | "status-bar"
  | "unknown";

export interface Block {
  type: BlockType;
  lines: ScreenLine[];
  content?: string;
  meta?: Record<string, unknown>;
}
