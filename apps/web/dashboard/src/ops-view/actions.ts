// Decision controls for the review and ticket panels: one primary action, the rest in a menu, a
// labelled note that grows, an inline confirm step, and a clear result. Plus toasts. server.ts inlines
// this file (types stripped) into ops.html.
import { icon } from "./overview.ts";

export type Outcome = { ok: boolean; message: string };
export type Action = {
  label: string;
  /** The confirm step's question, e.g. "Release $5.00 to the worker?" */
  confirm: string;
  /** The confirm button, e.g. "Release $5.00". Same verb as the label. */
  verb: string;
  tone: "primary" | "danger" | "ghost";
  run: (note: string) => Promise<Outcome>;
};
export type ActionAreaOptions = {
  primary: Action;
  more: Action[];
  note: { label: string; hint: string; required: boolean };
  /** Shown as a toast after a decision went through. */
  toast: (message: string) => void;
  id: string;
};

const el = <K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string) => {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const button = (doc: Document, text: string, cls: string) => {
  const b = el(doc, "button", `ui-button ui-button--sm ${cls}`, text);
  b.type = "button";
  return b;
};

export function actionArea(doc: Document, opts: ActionAreaOptions) {
  const root = el(doc, "div", "decide");
  const field = el(doc, "div", "decide__field");
  const noteId = `${opts.id}-note`;
  const label = el(doc, "label", "decide__label", opts.note.label);
  label.htmlFor = noteId;
  const note = el(doc, "textarea", "ui-input decide__note");
  note.id = noteId;
  note.rows = 2;
  note.maxLength = 500;
  const hint = el(doc, "p", "decide__hint", opts.note.hint);
  hint.id = `${noteId}-hint`;
  note.setAttribute("aria-describedby", hint.id);
  // Grows with what is typed (field-sizing does this in CSS where supported; this covers the rest).
  note.addEventListener("input", () => {
    note.style.height = "auto";
    note.style.height = `${note.scrollHeight}px`;
    note.removeAttribute("aria-invalid");
  });
  field.append(label, note, hint);

  const status = el(doc, "p", "decide__status");
  status.setAttribute("role", "status");
  const row = el(doc, "div", "decide__row");
  root.append(field, row, status);

  let menuOpen = false;
  const say = (tone: "ok" | "error" | "", text: string) => {
    status.className = `decide__status${tone ? ` is-${tone}` : ""}`;
    status.replaceChildren(...(tone ? [icon(doc, tone === "ok" ? "i-check" : "i-error")] : []), text);
  };

  function idle(focus?: HTMLElement) {
    menuOpen = false;
    const primary = button(doc, opts.primary.label, `ui-button--${opts.primary.tone}`);
    primary.addEventListener("click", () => confirming(opts.primary));
    const items: Node[] = [primary];
    if (opts.more.length) {
      const toggle = button(doc, "More actions", "ui-button--ghost decide__more");
      toggle.setAttribute("aria-haspopup", "menu");
      toggle.setAttribute("aria-expanded", "false");
      const menu = el(doc, "div", "decide__menu");
      menu.setAttribute("role", "menu");
      menu.hidden = true;
      const entries = opts.more.map((action) => {
        const item = el(doc, "button", `decide__item is-${action.tone}`, action.label);
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
        item.addEventListener("click", () => confirming(action));
        return item;
      });
      const show = (open: boolean) => {
        menuOpen = open;
        menu.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        if (open) entries[0]?.focus();
      };
      toggle.addEventListener("click", () => show(!menuOpen));
      menu.addEventListener("keydown", (e) => {
        const at = entries.indexOf(doc.activeElement as HTMLButtonElement);
        const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: entries.length - 1 }[e.key];
        if (e.key === "Escape") {
          e.preventDefault();
          show(false);
          toggle.focus();
        } else if (next !== undefined) {
          e.preventDefault();
          entries[(next + entries.length) % entries.length]?.focus();
        }
      });
      menu.append(...entries);
      const wrap = el(doc, "div", "decide__menuwrap");
      wrap.append(toggle, menu);
      items.push(wrap);
    }
    row.replaceChildren(...items);
    (focus ?? null)?.focus();
  }

  // The confirm step replaces the buttons in place: it says what will happen, the confirm button repeats the verb.
  function confirming(action: Action) {
    if (opts.note.required && !note.value.trim()) {
      note.setAttribute("aria-invalid", "true");
      say("error", `Write a note first. ${opts.note.hint}`);
      note.focus();
      idle();
      return;
    }
    say("", "");
    const question = el(doc, "span", "decide__question", action.confirm);
    const yes = button(doc, action.verb, `ui-button--${action.tone === "ghost" ? "primary" : action.tone}`);
    const no = button(doc, "Cancel", "ui-button--ghost");
    yes.addEventListener("click", () => run(action, yes, no));
    no.addEventListener("click", () => idle());
    row.replaceChildren(question, yes, no);
    row.classList.add("is-confirming");
    row.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        row.classList.remove("is-confirming");
        idle();
      }
    };
    yes.focus();
  }

  async function run(action: Action, yes: HTMLButtonElement, no: HTMLButtonElement) {
    yes.disabled = true;
    no.disabled = true;
    yes.textContent = `${action.verb}…`;
    const outcome = await action.run(note.value.trim()).catch(
      (err: unknown): Outcome => ({
        ok: false,
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      }),
    );
    row.classList.remove("is-confirming");
    row.onkeydown = null;
    if (!outcome.ok) {
      say("error", outcome.message);
      idle();
      return;
    }
    // Decided: the area locks; the list behind refreshes on its own.
    say("ok", outcome.message);
    note.disabled = true;
    row.replaceChildren();
    opts.toast(outcome.message);
  }

  idle();
  return root;
}

/** Bottom-of-screen toasts: polite, one at a time, 4 s each, paused while the tab is hidden. */
export function createToaster(doc: Document, later: (fn: () => void, ms: number) => () => void) {
  const region = el(doc, "div", "toasts");
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  doc.body.append(region);
  let cancel = () => {};
  let left = 0;
  let started = 0;
  const now = () => doc.defaultView?.performance.now() ?? 0;
  const close = () => {
    cancel();
    region.firstElementChild?.classList.add("is-leaving");
    cancel = later(() => region.replaceChildren(), 200);
  };
  const arm = () => {
    started = now();
    cancel = later(close, left);
  };
  doc.addEventListener("visibilitychange", () => {
    if (!region.firstElementChild || region.firstElementChild.classList.contains("is-leaving")) return;
    if (doc.visibilityState === "hidden") {
      cancel();
      left = Math.max(0, left - (now() - started));
    } else arm();
  });
  return (message: string) => {
    cancel();
    const toast = el(doc, "div", "toast");
    toast.append(icon(doc, "i-check"), message);
    region.replaceChildren(toast);
    left = 4000;
    arm();
  };
}
