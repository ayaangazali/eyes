/** A copy button. The text it copies is in its data-copy attribute. */
export type CopyButton = {
  dataset: { copy?: string };
  addEventListener: (type: "click", handler: () => Promise<void>) => void;
};

/** The status line that says what was copied. */
export type CopyStatus = { textContent: string | null; hidden: boolean };

/**
 * Wires each copy button to write its data-copy text to the clipboard, then shows the status line with the
 * trimmed text. When the write fails the handler rejects and the status line stays hidden.
 */
export function wireCopy(
  buttons: Iterable<CopyButton>,
  status: CopyStatus,
  write: (text: string) => Promise<void>,
): void {
  for (const button of buttons) {
    button.addEventListener("click", async () => {
      const text = button.dataset.copy ?? "";
      await write(text);
      status.textContent = `Copied: ${text.trim()}`;
      status.hidden = false;
    });
  }
}
