// The sign-in and message pages, shared by both installs. They name no product and link nowhere,
// so a visitor learns nothing about what runs behind them. They load nothing from elsewhere and
// run no script, so the strict page CSP (default-src 'none') holds.
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// A tileable field of grey squares, built once from a fixed seed: smooth value noise picks where
// squares cluster and how bright each one is.
const CELLS = 48;
const CELL = 12;
const DOT = 7;

function dotMatrix(): string {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const grid = (size: number) => Array.from({ length: size * size }, random);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (values: number[], size: number, x: number, y: number) => {
    const fx = (x / CELLS) * size;
    const fy = (y / CELLS) * size;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const at = (i: number, j: number) => values[(((j % size) + size) % size) * size + (((i % size) + size) % size)] ?? 0;
    const sx = smooth(fx - x0);
    const sy = smooth(fy - y0);
    const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
    const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bottom * sy;
  };
  const coarse = grid(6);
  const fine = grid(16);
  const dots: string[] = [];
  for (let y = 0; y < CELLS; y += 1) {
    for (let x = 0; x < CELLS; x += 1) {
      const density = 0.7 * noise(coarse, 6, x, y) + 0.3 * noise(fine, 16, x, y);
      if (random() > (density - 0.42) * 1.6) continue;
      const glow = random();
      const shade = Math.min(0.85, 0.1 + glow * glow * density * 1.1).toFixed(2);
      dots.push(`<rect x="${x * CELL}" y="${y * CELL}" width="${DOT}" height="${DOT}" fill-opacity="${shade}"/>`);
    }
  }
  const tile = CELLS * CELL;
  return `<svg class="matrix" aria-hidden="true" focusable="false"><defs><pattern id="dots" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse">${dots.join("")}</pattern></defs><rect width="100%" height="100%" fill="url(#dots)"/></svg>`;
}

const MATRIX = dotMatrix();

export function loginPage(error: string | null): string {
  return page(
    "Sign in",
    `<h1>Sign in</h1>
      ${error === null ? "" : `<p class="alert" role="alert">${escapeHtml(error)}</p>`}
      <form method="post" action="/login">
        <input type="text" name="username" value="admin" autocomplete="username" hidden>
        <label for="password">Password</label>
        <input id="password" type="password" name="password" autocomplete="current-password" placeholder="Enter your password" required autofocus>
        <button type="submit">Sign in</button>
      </form>`,
  );
}

export function messagePage(title: string, text: string, failed: boolean): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>
      <p class="${failed ? "alert" : "note"}" role="${failed ? "alert" : "status"}">${escapeHtml(text)}</p>
      <form method="get" action="/management.html"><button type="submit">Open the dashboard</button></form>`,
  );
}

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --text: #1c1917; --muted: #57534e; --dots: #1c1917; --field: #f5f5f4; --line: #d6d3d1; --focus: #1c1917;
    --button: #1c1917; --button-text: #fafaf9; --error: #b91c1c; --error-bg: #fef2f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000; --text: #f5f5f4; --muted: #a3a3a3; --dots: #f5f5f4; --field: rgba(255, 255, 255, .05); --line: rgba(255, 255, 255, .12); --focus: rgba(255, 255, 255, .5);
      --button: #f5f5f4; --button-text: #0a0a0a; --error: #fca5a5; --error-bg: rgba(248, 113, 113, .1);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: grid; grid-template-columns: 55fr 45fr; min-height: 100vh; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased;
  }
  .art { position: relative; overflow: hidden; color: var(--dots); }
  .matrix { position: absolute; inset: 0; width: 100%; height: 100%; fill: currentColor;
    -webkit-mask-image: linear-gradient(90deg, #000 70%, transparent); mask-image: linear-gradient(90deg, #000 70%, transparent); }
  .art::after { content: ""; position: absolute; inset: auto 0 0; height: 38%; background: linear-gradient(0deg, var(--bg) 25%, transparent); pointer-events: none; }
  .art p { position: absolute; z-index: 1; left: 0; right: 0; bottom: 72px; margin: 0; text-align: center; font-size: clamp(28px, 2.6vw, 38px); font-weight: 700; letter-spacing: -.02em; }
  main { display: flex; align-items: center; justify-content: center; padding: 48px 32px; }
  .panel { width: min(360px, 100%); }
  h1 { margin: 0 0 28px; font-size: 32px; font-weight: 600; letter-spacing: -.02em; line-height: 1.15; }
  label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 500; color: var(--muted); }
  input[type="password"] {
    display: block; width: 100%; height: 44px; margin-bottom: 24px; padding: 0 14px; font: inherit; color: inherit;
    background: var(--field); border: 1px solid var(--line); border-radius: 10px; transition: border-color .15s;
  }
  input[type="password"]::placeholder { color: var(--muted); opacity: .8; }
  input[type="password"]:focus { outline: none; border-color: var(--focus); }
  button {
    display: block; width: 100%; height: 44px; font: inherit; font-weight: 600; color: var(--button-text); background: var(--button);
    border: 0; border-radius: 10px; cursor: pointer; transition: opacity .15s;
  }
  button:hover { opacity: .9; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
  .alert, .note { margin: -12px 0 24px; padding: 10px 14px; border-radius: 10px; }
  .alert { color: var(--error); background: var(--error-bg); }
  .note { color: var(--muted); background: var(--field); }
  @media (max-width: 820px) {
    body { grid-template-columns: 1fr; grid-template-rows: 240px 1fr; }
    .matrix { -webkit-mask-image: linear-gradient(180deg, #000 40%, transparent); mask-image: linear-gradient(180deg, #000 40%, transparent); }
    .art p { display: none; }
    main { align-items: flex-start; padding: 8px 24px 48px; }
    .panel { width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="art">${MATRIX}<p>Welcome back.</p></div>
<main>
  <section class="panel">
      ${content}
  </section>
</main>
</body>
</html>
`;
}
