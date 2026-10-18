// The one site header. The landing page and the worker web render it with <Fragment set:html>, the
// API's server-rendered pages as PAGE_HEADER. Styles: .ui-site-head in components.css. Each site sets
// --ui-column to its page column, so the wordmark starts where the page text starts.

/** `nav` and `cta` are trusted markup from our own layouts, never user input. */
export function siteHeader({ home = "https://eyes.pictures", nav = "", cta = "" } = {}): string {
  return `<header class="ui-site-head"><div class="ui-site-head__inner"><a class="ui-site-head__home" href="${home}"><span class="ui-mark" aria-hidden="true"></span>Eyes</a>${nav}${cta}</div></header>`;
}
