import { Terminal } from "@xterm/xterm";

const COLS = 120;
const ROWS = 40;

export class HiddenTerminal {
  readonly terminal: Terminal;
  private listeners: Array<() => void> = [];

  constructor() {
    this.terminal = new Terminal({
      cols: COLS,
      rows: ROWS,
      allowProposedApi: true,
    });
  }

  mount(container: HTMLElement) {
    this.terminal.open(container);
  }

  write(data: Uint8Array) {
    this.terminal.write(data);
    this.notifyListeners();
  }

  onBufferChange(fn: () => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  resize(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
  }

  dispose() {
    this.terminal.dispose();
  }

  private notifyListeners() {
    for (const fn of this.listeners) {
      fn();
    }
  }
}
