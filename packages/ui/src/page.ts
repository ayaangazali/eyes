// Server-rendered pages on the API host (home, status, payments, owner controls). Those are HTML
// strings with no bundler, so the design system is inlined: tokens.css and components.css read once
// at startup, plus a page skeleton that styles the plain markup the templates already emit
// (h1, p, dl, table, form, .box, .button, .note). System fonts, with Instrument Sans for h1 (the API
// serves the file at /fonts/instrument-sans.woff2). Light and dark from the tokens.
import { readFileSync } from "node:fs";
import { siteHeader } from "./header.ts";

const SKELETON = `
body.ui{margin:0;min-height:100dvh;background:var(--eyes-surface);--ui-column:40rem}
@font-face{font-family:"Instrument Sans Variable";font-style:normal;font-display:swap;font-weight:400 700;src:url(/fonts/instrument-sans.woff2) format("woff2")}
.page{max-width:var(--ui-column);margin:0 auto;padding:3rem 1.25rem 5rem}
.page h1{margin:0 0 1rem;font-size:clamp(2rem,6vw,2.75rem);line-height:1.05;font-weight:600;letter-spacing:-.035em;text-wrap:balance}
.page h2{margin:2.5rem 0 .75rem;font-size:1.25rem;line-height:1.25;font-weight:600;letter-spacing:-.015em}
.page p{margin:0 0 1rem}
.page ul{margin:0 0 1rem;padding-left:1.25rem}.page li{margin-bottom:.5rem}
.page a{color:inherit;text-decoration-color:var(--eyes-accent);text-decoration-thickness:2px;text-underline-offset:.18em}
.page code{font:.875em var(--eyes-font-mono);padding:.1em .35em;border-radius:.375rem;background:var(--eyes-surface-tertiary)}
.muted,.hint{color:var(--eyes-text-secondary)}
.hint{font-size:var(--eyes-text-sm)}
.box{margin:1.5rem 0;padding:1.25rem 1.5rem .5rem;border-radius:var(--eyes-radius-2xl);background:var(--eyes-surface-secondary);box-shadow:var(--eyes-hairline)}
.box h2{margin-top:0}
.page .button,.page button{box-sizing:border-box;display:inline-grid;place-items:center;height:var(--eyes-tap);margin:.5rem 0 1rem;padding:0 1.5rem;border:0;border-radius:var(--eyes-radius-full);background:var(--eyes-accent);color:var(--eyes-on-accent);font:inherit;font-weight:600;line-height:1;text-decoration:none;cursor:pointer;transition:background-color var(--eyes-duration) ease,box-shadow var(--eyes-duration) ease,transform var(--eyes-duration-press) var(--eyes-ease-out);-webkit-tap-highlight-color:transparent}
@media (hover:hover) and (pointer:fine){.page .button:hover,.page button:hover{background:var(--eyes-accent-hover)}.page .button--quiet:hover{background:var(--eyes-surface-tertiary);box-shadow:inset 0 0 0 1.5px var(--eyes-accent)}}
.page .button:active,.page button:active:not(:disabled){transform:scale(var(--eyes-press-scale))}
.page button.danger{background:var(--eyes-danger-text);color:var(--eyes-surface)}
.links a{display:inline-block;margin-right:1.25rem;line-height:2.25}
.rows{list-style:none;margin:1.5rem 0;padding:0;border-top:1px solid var(--eyes-border-subtle)}.page .rows li{margin:0;padding:.875rem 0;border-bottom:1px solid var(--eyes-border-subtle)}
.state::before{content:"";display:inline-block;width:.5rem;height:.5rem;margin:0 .5rem .1rem 0;border-radius:50%;background:var(--eyes-text-tertiary)}
.state.live::before{background:var(--eyes-success-text)}
.page dl{display:grid;grid-template-columns:auto 1fr;gap:.625rem 1.5rem;margin:1.5rem 0;padding:1.25rem 1.5rem;border-radius:var(--eyes-radius-2xl);background:var(--eyes-surface-secondary);box-shadow:var(--eyes-hairline)}
.page dt{color:var(--eyes-text-secondary)}.page dd{margin:0;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
.page label{display:block;margin-top:1.25rem;font-weight:600}
.page input[type=number]{box-sizing:border-box;display:block;width:100%;min-height:var(--eyes-tap);margin-top:.375rem;padding:0 .875rem;border:1px solid var(--eyes-border);border-radius:.75rem;background:var(--eyes-surface);color:var(--eyes-text);font:inherit;font-variant-numeric:tabular-nums}
.page input[type=number]:focus-visible{outline:2px solid var(--eyes-accent);outline-offset:1px}
.page fieldset{margin:1.25rem 0 0;padding:.5rem 1rem 1rem;border:1px solid var(--eyes-border-subtle);border-radius:.75rem}
.page legend{padding:0 .25rem;font-weight:600}
.page fieldset label{display:flex;align-items:center;gap:.625rem;margin-top:.625rem;font-weight:400}
.page input[type=checkbox]{flex:none;width:1.25rem;height:1.25rem;margin:0;accent-color:var(--eyes-text)}
form > label:has(input[type=checkbox]){display:flex;align-items:flex-start;gap:.625rem;font-weight:400}
.note{padding:.875rem 1rem;border-radius:.75rem;background:var(--eyes-success-bg);color:var(--eyes-success-text)}
.note.error{background:var(--eyes-danger-bg);color:var(--eyes-danger-text)}
.key{font:1rem var(--eyes-font-mono);word-break:break-all;padding:1rem;border-radius:.75rem;background:var(--eyes-surface-secondary);box-shadow:var(--eyes-hairline)}
.scroll{overflow-x:auto;margin:0 0 1rem}
.page table{width:100%;border-collapse:collapse;font-size:var(--eyes-text-sm);font-variant-numeric:tabular-nums}
.page th{color:var(--eyes-text-secondary);font-weight:500;text-align:left;padding:.5rem .75rem .5rem 0;border-bottom:1px solid var(--eyes-border)}
.page td{text-align:left;vertical-align:top;padding:.625rem .75rem .625rem 0;border-bottom:1px solid var(--eyes-border-subtle)}
.page dl.totals{grid-template-columns:1fr 1fr;gap:1rem;padding:0;background:none;box-shadow:none}
.totals > div{display:flex;flex-direction:column;justify-content:space-between;padding:1.25rem 1.25rem 1rem;border-radius:var(--eyes-radius-2xl);background:var(--eyes-surface-secondary);box-shadow:var(--eyes-hairline)}
.page .totals dt{font-size:var(--eyes-text-sm)}
.page .totals dd{margin-top:.375rem;font-size:clamp(1.75rem,7vw,2.5rem);line-height:1;letter-spacing:-.03em;text-align:left}
.totals > div:first-child{box-shadow:inset 0 0 0 2px var(--eyes-accent)}
.tasks{display:grid;gap:.75rem;margin:0 0 1rem;padding:0;list-style:none}
.page .task{margin:0;padding:1rem 1.25rem;border-radius:var(--eyes-radius-2xl);background:var(--eyes-surface-secondary);box-shadow:var(--eyes-hairline)}
.task p{margin:0}.task > * + *{margin-top:.375rem}
.task__top{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.task__bounty{font-weight:600;font-variant-numeric:tabular-nums}
.task__question{font-weight:600;line-height:1.3}
.task__place,.task__payout,.task__when{color:var(--eyes-text-secondary);font-size:var(--eyes-text-sm)}
.eyebrow{margin:0 0 .75rem;color:var(--eyes-text-secondary);font:500 var(--eyes-text-sm) var(--eyes-font-mono)}
.docs{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.75rem;margin:1rem 0 0;padding:0;list-style:none}
.page .docs li{display:grid;gap:.125rem;margin:0;padding:1rem 1.25rem;border-radius:var(--eyes-radius-2xl);background:var(--eyes-surface-secondary);box-shadow:var(--eyes-hairline)}
.docs a{display:flex;align-items:center;min-height:var(--eyes-tap);font:600 1rem var(--eyes-font-mono)}.docs span{color:var(--eyes-text-secondary);font-size:var(--eyes-text-sm)}
.cta{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(12rem,100%),1fr));gap:.75rem;max-width:28rem;margin:1rem 0}
.page .cta .button{margin:0}
.page .button--quiet{background:var(--eyes-surface-tertiary);color:var(--eyes-text)}
.notice-page{position:relative;display:grid;align-content:center;justify-items:start;gap:.25rem;min-height:min(28rem,calc(100dvh - 12rem));margin-top:1rem;padding:2.5rem 2rem;border-radius:var(--eyes-radius-2xl);background:var(--eyes-surface-secondary);box-shadow:var(--eyes-hairline)}
.notice-page::before{content:"";position:absolute;inset:.75rem;pointer-events:none;background:
linear-gradient(var(--eyes-accent) 0 0) top left/1.25rem 3px no-repeat,linear-gradient(var(--eyes-accent) 0 0) top left/3px 1.25rem no-repeat,
linear-gradient(var(--eyes-accent) 0 0) top right/1.25rem 3px no-repeat,linear-gradient(var(--eyes-accent) 0 0) top right/3px 1.25rem no-repeat,
linear-gradient(var(--eyes-accent) 0 0) bottom left/1.25rem 3px no-repeat,linear-gradient(var(--eyes-accent) 0 0) bottom left/3px 1.25rem no-repeat,
linear-gradient(var(--eyes-accent) 0 0) bottom right/1.25rem 3px no-repeat,linear-gradient(var(--eyes-accent) 0 0) bottom right/3px 1.25rem no-repeat}
.notice-page p{max-width:32rem;color:var(--eyes-text-secondary);font-size:var(--eyes-text-lg)}
.ledger{margin:0 0 1rem;padding:0;list-style:none;border-top:1px solid var(--eyes-border-subtle)}
.page .ledger li{display:grid;grid-template-columns:1fr auto;gap:.125rem 1rem;margin:0;padding:.75rem 0;border-bottom:1px solid var(--eyes-border-subtle)}
.ledger__what{font-weight:600}.ledger__amount{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.ledger__meta{grid-column:1/-1;color:var(--eyes-text-secondary);font-size:var(--eyes-text-sm)}
`;

export const PAGE_CSS =
  readFileSync(new URL("./tokens.css", import.meta.url), "utf8") +
  readFileSync(new URL("./components.css", import.meta.url), "utf8") +
  SKELETON;

/** The shared site header, lined up with the page column (--ui-column above). Static HTML, safe to inline. */
export const PAGE_HEADER = siteHeader();
