// The sign-in landing and message pages, shared by both installs. They load nothing from
// elsewhere and run no script, so the strict page CSP (default-src 'none') holds.
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const LOGO = `<svg class="logo" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cff"/><stop offset="1" stop-color="#22c3e6"/></linearGradient></defs>
  <rect width="40" height="40" rx="11" fill="url(#g)"/>
  <path d="M10 12.5c6 0 7 7.5 12.5 7.5M10 20h12.5M10 27.5c6 0 7-7.5 12.5-7.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M22.5 20h7.5m-3.2-3.6L30.4 20l-3.6 3.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const ICONS = {
  formats: `<path d="M8 6 3 12l5 6M16 6l5 6-5 6" />`,
  cloud: `<path d="M7 18h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.6 10.1 4 4 0 0 0 7 18Z" />`,
  lock: `<rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />`,
  check: `<path d="m5 12.5 4.5 4.5L19 7.5" />`,
  alert: `<path d="M12 8v5M12 16.5v.01" /><circle cx="12" cy="12" r="9" />`,
  arrow: `<path d="M5 12h14m-5-5 5 5-5 5" />`,
} as const;

function icon(name: keyof typeof ICONS, className = "icon"): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

const FEATURES: readonly [keyof typeof ICONS, string, string][] = [
  ["formats", "One API, every format", "Clients speak OpenAI, Claude or Gemini. The gateway routes each call to your logins and keys."],
  ["cloud", "Runs on your Cloudflare account", "Deployed to your own account, with no shared gateway in between."],
  ["lock", "Secrets stay on the server", "Sign in once. The management key never reaches the browser."],
];

function alert(text: string, failed: boolean): string {
  return `<p class="alert ${failed ? "alert-error" : "alert-ok"}" role="${failed ? "alert" : "status"}">${icon(failed ? "alert" : "check")}<span>${escapeHtml(text)}</span></p>`;
}

export function loginPage(error: string | null): string {
  return page(
    "Sign in",
    `<h2>Welcome back</h2>
      <p class="lead">Sign in to open your dashboard.</p>
      ${error === null ? "" : alert(error, true)}
      <form method="post" action="/login">
        <input type="text" name="username" value="sub2api" autocomplete="username" hidden>
        <label for="password">Password</label>
        <div class="field">
          ${icon("lock")}
          <input id="password" type="password" name="password" autocomplete="current-password" placeholder="Dashboard password" required autofocus>
        </div>
        <button type="submit">Sign in ${icon("arrow")}</button>
      </form>
      <p class="fine">Signed-in sessions last 12 hours.</p>`,
  );
}

export function messagePage(title: string, text: string, failed: boolean): string {
  return page(
    title,
    `<div class="badge ${failed ? "badge-error" : "badge-ok"}">${icon(failed ? "alert" : "check")}</div>
      <h2>${escapeHtml(title)}</h2>
      <p class="lead">${escapeHtml(text)}</p>
      <form method="get" action="/management.html"><button type="submit">Open the dashboard ${icon("arrow")}</button></form>`,
  );
}

function page(title: string, card: string): string {
  const features = FEATURES.map(
    ([name, heading, text]) => `<li>${icon(name, "icon feature-icon")}<div><strong>${heading}</strong><span>${text}</span></div></li>`,
  ).join("\n          ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(title)} · sub2api</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f6fb; --bg-glow-1: rgba(124, 108, 255, .20); --bg-glow-2: rgba(34, 195, 230, .16); --grid: rgba(20, 24, 60, .05);
    --card: rgba(255, 255, 255, .86); --card-line: rgba(20, 24, 60, .10); --shadow: 0 24px 60px -24px rgba(30, 34, 80, .28);
    --text: #12142a; --muted: #5b6079; --faint: #8a8fa8; --field: #fff; --field-line: #d5d8e6;
    --accent: #5b4cf0; --accent-2: #18a9cf; --focus: rgba(91, 76, 240, .28);
    --error: #c2253b; --error-bg: rgba(194, 37, 59, .08); --ok: #0f8a5f; --ok-bg: rgba(15, 138, 95, .09);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0b14; --bg-glow-1: rgba(124, 108, 255, .26); --bg-glow-2: rgba(34, 195, 230, .16); --grid: rgba(255, 255, 255, .035);
      --card: rgba(20, 22, 38, .78); --card-line: rgba(255, 255, 255, .09); --shadow: 0 30px 80px -30px rgba(0, 0, 0, .8);
      --text: #eef0fb; --muted: #a2a7c4; --faint: #6f7491; --field: rgba(255, 255, 255, .04); --field-line: rgba(255, 255, 255, .12);
      --accent: #8b7dff; --accent-2: #3fd0f0; --focus: rgba(139, 125, 255, .35);
      --error: #ff8597; --error-bg: rgba(255, 133, 151, .10); --ok: #5fe0ac; --ok-bg: rgba(95, 224, 172, .10);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    min-height: 100vh; display: flex; flex-direction: column; color: var(--text); background: var(--bg);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background:
      radial-gradient(42rem 30rem at 12% 8%, var(--bg-glow-1), transparent 70%),
      radial-gradient(38rem 28rem at 92% 88%, var(--bg-glow-2), transparent 70%),
      linear-gradient(var(--grid) 1px, transparent 1px) 0 0 / 44px 44px,
      linear-gradient(90deg, var(--grid) 1px, transparent 1px) 0 0 / 44px 44px;
  }
  main { flex: 1; width: min(1080px, 100%); margin: 0 auto; padding: 48px 24px; display: grid; grid-template-columns: 1.1fr .9fr; gap: 64px; align-items: center; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 20px; letter-spacing: -.01em; }
  .logo { width: 40px; height: 40px; flex: none; filter: drop-shadow(0 8px 18px rgba(91, 76, 240, .35)); }
  .eyebrow { margin: 40px 0 12px; font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
  h1 { margin: 0; font-size: clamp(32px, 4.4vw, 48px); line-height: 1.08; letter-spacing: -.03em; font-weight: 750; max-width: 15ch; }
  h1 em { font-style: normal; background: linear-gradient(90deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .intro { margin: 18px 0 0; color: var(--muted); font-size: 17px; max-width: 34rem; }
  .features { list-style: none; margin: 36px 0 0; padding: 0; display: grid; gap: 20px; max-width: 32rem; }
  .features li { display: flex; gap: 14px; align-items: flex-start; }
  .features strong { display: block; font-size: 15px; font-weight: 650; }
  .features span { display: block; color: var(--muted); font-size: 14px; }
  .icon { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
  .feature-icon { width: 38px; height: 38px; padding: 9px; border-radius: 11px; color: var(--accent); background: var(--card); border: 1px solid var(--card-line); }
  .card {
    position: relative; padding: 36px; border-radius: 22px; background: var(--card); border: 1px solid var(--card-line); box-shadow: var(--shadow);
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
  }
  .card::before { content: ""; position: absolute; inset: 0 24px auto; height: 1px; background: linear-gradient(90deg, transparent, var(--accent), var(--accent-2), transparent); opacity: .7; }
  h2 { margin: 0; font-size: 24px; letter-spacing: -.02em; }
  .lead { margin: 6px 0 24px; color: var(--muted); }
  label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 600; }
  .field { position: relative; margin-bottom: 18px; }
  .field .icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--faint); width: 18px; height: 18px; pointer-events: none; }
  input[type="password"] {
    width: 100%; font: inherit; color: inherit; padding: 13px 14px 13px 42px; border-radius: 12px; border: 1px solid var(--field-line); background: var(--field);
    transition: border-color .15s, box-shadow .15s;
  }
  input[type="password"]::placeholder { color: var(--faint); }
  input[type="password"]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--focus); }
  button {
    width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font: inherit; font-weight: 650; color: #fff; cursor: pointer;
    padding: 13px 16px; border: 0; border-radius: 12px; background: linear-gradient(135deg, #6a5cf5, #5b4cf0 45%, #2e8fe0);
    box-shadow: 0 10px 24px -10px rgba(91, 76, 240, .7), inset 0 1px 0 rgba(255, 255, 255, .18); transition: transform .15s, box-shadow .15s, filter .15s;
  }
  button:hover { filter: brightness(1.07); box-shadow: 0 14px 28px -10px rgba(91, 76, 240, .8), inset 0 1px 0 rgba(255, 255, 255, .18); }
  button:active { transform: translateY(1px); }
  button:focus-visible { outline: none; box-shadow: 0 0 0 4px var(--focus); }
  button .icon { width: 18px; height: 18px; }
  .alert { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 20px; padding: 11px 14px; border-radius: 12px; font-size: 14px; }
  .alert .icon { width: 18px; height: 18px; margin-top: 2px; }
  .alert-error { color: var(--error); background: var(--error-bg); }
  .alert-ok { color: var(--ok); background: var(--ok-bg); }
  .badge { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 16px; margin-bottom: 18px; }
  .badge .icon { width: 26px; height: 26px; }
  .badge-error { color: var(--error); background: var(--error-bg); }
  .badge-ok { color: var(--ok); background: var(--ok-bg); }
  .fine { margin: 18px 0 0; text-align: center; color: var(--faint); font-size: 13px; }
  footer { padding: 0 24px 28px; text-align: center; color: var(--faint); font-size: 13px; }
  @media (max-width: 860px) {
    main { grid-template-columns: 1fr; align-content: center; gap: 28px; padding: 32px 16px; max-width: 480px; }
    .eyebrow { margin-top: 28px; }
    h1 { font-size: 32px; }
    .intro { font-size: 16px; }
    .features { display: none; }
    .card { padding: 28px 22px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<main>
  <section class="hero">
    <div class="brand">${LOGO}<span>sub2api</span></div>
    <p class="eyebrow">Private AI gateway</p>
    <h1>Your models, <em>one private API.</em></h1>
    <p class="intro">Manage providers, logins, API keys and usage for this gateway.</p>
    <ul class="features">
          ${features}
    </ul>
  </section>
  <section class="card">
      ${card}
  </section>
</main>
<footer>sub2api · built on CLIProxyAPI</footer>
</body>
</html>
`;
}
