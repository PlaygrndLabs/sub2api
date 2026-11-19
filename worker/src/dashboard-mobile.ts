// CPA's dashboard shows AI Providers as a list beside the selected provider's panel, but below
// 1280px it stacks them, so on a phone a tap changes a panel far below the list. This script makes
// the stacked layout two views instead: the list, then the tapped provider's panel with a Back
// button. It finds the dashboard's parts by their CSS module names; if a release renames them, or the
// layout has two columns, it does nothing and the dashboard keeps its own layout. Static code only:
// it reads no data and sends nothing.
const LAYOUT = '[class*="ProvidersWorkbenchPage-module__layout___"]';
const LIST = '[class*="ProviderCategoryList-module__stack___"]';
const PANEL = '[class*="ProviderResourcePanel-module__panel___"]';
const ITEM = '[class*="ProviderCategoryList-module__item___"]';
const VIEW = "data-sub2api-providers";

const STYLE = `html[${VIEW}="list"] ${LAYOUT} > ${PANEL},
html[${VIEW}="panel"] ${LAYOUT} > ${LIST} { display: none !important; }
html[${VIEW}="panel"] ${LAYOUT} > ${PANEL} { margin-bottom: 72px; }
#sub2api-providers-back { display: none; position: fixed; z-index: 50; left: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  align-items: center; gap: 6px; height: 44px; padding: 0 18px; border-radius: 22px; font: inherit; font-size: 15px; font-weight: 500; cursor: pointer;
  color: var(--text-primary, #2d2a26); background: var(--bg-primary, #fff); border: 1px solid var(--border-color, #e5e5e5);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12); }
html[${VIEW}="panel"] #sub2api-providers-back { display: inline-flex; }`;

const SCRIPT = `(() => {
  try {
    const root = document.documentElement;
    let layout = null;
    let listScroll = 0;
    const parts = () => {
      const found = document.querySelector(${JSON.stringify(LAYOUT)});
      if (found === null) return null;
      const list = found.querySelector(":scope > " + ${JSON.stringify(LIST)});
      const panel = found.querySelector(":scope > " + ${JSON.stringify(PANEL)});
      if (list === null || panel === null) return null;
      if (getComputedStyle(found).gridTemplateColumns.trim().split(/\\s+/).length !== 1) return null;
      return found;
    };
    const show = (view) => {
      if (view === null) root.removeAttribute(${JSON.stringify(VIEW)});
      else if (root.getAttribute(${JSON.stringify(VIEW)}) !== view) root.setAttribute(${JSON.stringify(VIEW)}, view);
    };
    const sync = () => {
      const found = parts();
      if (found === null) { layout = null; show(null); return; }
      if (found !== layout || !root.hasAttribute(${JSON.stringify(VIEW)})) { layout = found; show("list"); }
      const back = document.getElementById("sub2api-providers-back");
      if (back !== null) back.style.left = Math.max(16, Math.round(found.getBoundingClientRect().left)) + "px";
    };
    let queued = false;
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; sync(); }); } };
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target === null || layout === null || !root.hasAttribute(${JSON.stringify(VIEW)})) return;
      if (target.closest("#sub2api-providers-back")) { show("list"); scrollTo(0, listScroll); return; }
      if (target.closest(${JSON.stringify(ITEM)}) && layout.contains(target)) { listScroll = scrollY; show("panel"); scrollTo(0, 0); later(); }
    });
    addEventListener("hashchange", () => show(null));
    addEventListener("resize", later);
    const start = () => {
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(STYLE)};
      document.head.appendChild(style);
      const back = document.createElement("button");
      back.type = "button";
      back.id = "sub2api-providers-back";
      back.setAttribute("aria-label", "Back to providers");
      back.textContent = "\\u2190 Providers";
      document.body.appendChild(back);
      new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
      sync();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  } catch {}
})();`;

export const MOBILE_TAG = `<script>${SCRIPT}</script>`;
