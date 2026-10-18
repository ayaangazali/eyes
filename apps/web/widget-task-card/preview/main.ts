import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { DEMO, FIXTURES } from "../fixtures/index.ts";
import { MockBridge } from "../src/bridge.ts";
import { TaskCard } from "../src/card.ts";
import type { CardData, Theme } from "../src/types.ts";

const byId = (id: string) => document.getElementById(id) as HTMLElement;
let theme: Theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
const bridges: MockBridge[] = [];

function mount(el: HTMLElement, data: CardData) {
  const bridge = new MockBridge(data, theme);
  bridges.push(bridge);
  createRoot(el).render(createElement(TaskCard, { bridge }));
  return bridge;
}

function applyTheme(next: Theme) {
  theme = next;
  document.documentElement.dataset.theme = next;
  byId("theme").textContent = next === "dark" ? "Light" : "Dark";
  for (const b of bridges) b.update(b.getToolOutput(), next);
}

const demo = mount(byId("demo"), DEMO[0] as CardData);
for (const [state, data] of Object.entries(FIXTURES)) {
  const title = document.createElement("h2");
  title.textContent = state;
  byId("cols").append(title);
  for (const width of [320, 420]) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.id = `${state}-${width}`;
    cell.style.width = `${width}px`;
    byId("cols").append(cell);
    mount(cell, data);
  }
}

applyTheme(theme);
byId("theme").onclick = () => applyTheme(theme === "dark" ? "light" : "dark");
let stop = () => {};
byId("play").onclick = () => {
  stop();
  stop = demo.play(DEMO, 1800);
};
