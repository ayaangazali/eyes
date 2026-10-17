import type { CardData, Theme, ToolCall } from "./types.ts";

export interface WidgetBridge {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  getToolOutput(): CardData;
  onUpdate(cb: () => void): () => void;
  getTheme(): Theme;
}

export class MockBridge implements WidgetBridge {
  readonly calls: ToolCall[] = [];
  #data: CardData;
  #theme: Theme;
  #listeners = new Set<() => void>();

  constructor(data: CardData, theme: Theme = "light") {
    this.#data = data;
    this.#theme = theme;
  }

  callTool = async (name: string, args: Record<string, unknown>) => {
    this.calls.push({ name, args });
    return `Mock call: ${name}`;
  };

  getToolOutput = () => this.#data;

  getTheme = () => this.#theme;

  onUpdate = (cb: () => void) => {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  };

  update(data: CardData, theme: Theme = this.#theme) {
    this.#data = data;
    this.#theme = theme;
    for (const cb of this.#listeners) cb();
  }

  play(steps: CardData[], ms: number): () => void {
    let i = 0;
    const next = () => {
      const step = steps[i++];
      if (step) this.update(step);
      if (i >= steps.length) clearInterval(timer);
    };
    const timer = setInterval(next, ms);
    next();
    return () => clearInterval(timer);
  }
}

const notWired = (): never => {
  throw new Error("W2: HostBridge is not wired to the MCP Apps host yet");
};

export const HostBridge: WidgetBridge = {
  callTool: notWired,
  getToolOutput: notWired,
  onUpdate: notWired,
  getTheme: notWired,
};
