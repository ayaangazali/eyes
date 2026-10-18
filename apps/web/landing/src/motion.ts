/** Element shapes the landing motion code uses. Real DOM elements satisfy them. */
type ClassList = {
  add(name: string): void;
  remove(name: string): void;
  toggle(name: string, force: boolean): unknown;
};

export type Clickable = {
  addEventListener: (type: "click", handler: () => Promise<void>) => void;
};

export type TextNode = { textContent: string | null };

/** Shown after the connect command is copied. */
export const COPIED_HINT = "Copied. Run it in the terminal where EYES_API_KEY is set.";

/**
 * Copies the connect command when the copy button is clicked, then shows the hint. With no button there is
 * nothing to wire. With no connect element the empty string is copied. When the write fails the hint is
 * left as it was.
 */
export function wireCopy(
  button: Clickable | null,
  source: TextNode | null,
  hint: TextNode,
  write: (text: string) => Promise<void>,
): void {
  button?.addEventListener("click", async () => {
    await write(source?.textContent ?? "");
    hint.textContent = COPIED_HINT;
  });
}

export type FlightPanel = { dataset: { step?: string } };
export type FlightStep = { dataset: { step?: string }; classList: ClassList };
export type FlightRow = { dataset: { hl?: string; state?: string } };
export type FlightStatus = TextNode & {
  classList: ClassList;
  getBoundingClientRect: () => unknown;
};

/** How long the badge label stays in its exit state before the new text appears. */
export const SWAP_MS = 150;

/**
 * The flight panel's discrete state. show(n) makes row n current, sets the panel's data-step, lights the step
 * that row highlights, and swaps the badge label after SWAP_MS. Showing the row already on screen does nothing.
 */
export function createFlight(parts: {
  panel: FlightPanel;
  status: FlightStatus;
  steps: FlightStep[];
  rows: FlightRow[];
}) {
  const { panel, status, steps, rows } = parts;
  let at = rows.length - 1;

  // n is always a row index: callers pass 0..rows.length-1.
  const show = (n: number) => {
    if (n === at) return;
    at = n;
    const hl = (rows[n] as FlightRow).dataset.hl;
    panel.dataset.step = String(n);
    for (const step of steps) step.classList.toggle("is-now", step.dataset.step === hl);
    status.classList.add("is-exit");
    setTimeout(() => {
      status.textContent = (rows[at] as FlightRow).dataset.state ?? "";
      status.classList.remove("is-exit");
      status.classList.add("is-enter-start");
      status.getBoundingClientRect();
      status.classList.remove("is-enter-start");
    }, SWAP_MS);
  };

  return { show };
}
