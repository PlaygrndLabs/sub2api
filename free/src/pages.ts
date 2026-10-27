export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function loginPage(error: string | null): string {
  return page(`<section class="narrow">
  <h1>sub2api</h1>
  <p class="muted">Sign in to open the dashboard.</p>
  ${notice(error, true)}
  <form method="post" action="/login">
    <input type="password" name="password" autocomplete="current-password" placeholder="Dashboard password" required autofocus>
    <button type="submit">Sign in</button>
  </form>
</section>`);
}

export function messagePage(title: string, text: string, failed: boolean): string {
  return page(`<section class="narrow">
  <h1>${escapeHtml(title)}</h1>
  ${notice(text, failed)}
  <form method="get" action="/management.html"><button type="submit">Open the dashboard</button></form>
</section>`);
}

function notice(text: string | null, error: boolean): string {
  return text === null ? "" : `<p class="${error ? "error" : "notice"}">${escapeHtml(text)}</p>`;
}

function page(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sub2api</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #d9d9d4; --accent: #2f5bd3; --error: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1f1d; --text: #ededea; --muted: #a3a39d; --line: #3a3a36; --accent: #8aa8ff; --error: #ff8a80; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  section { max-width: 720px; margin: 32px auto; padding: 24px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-sizing: border-box; width: calc(100vw - 32px); }
  section.narrow { max-width: 360px; margin-top: 15vh; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  header button { width: auto; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  h2 { margin: 28px 0 8px; font-size: 16px; }
  .muted { color: var(--muted); }
  .error { color: var(--error); }
  .notice { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; }
  input, button { box-sizing: border-box; font: inherit; padding: 8px 12px; border-radius: 8px; }
  input { width: 100%; border: 1px solid var(--line); background: transparent; color: inherit; margin-bottom: 8px; }
  button { border: 0; background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
  form.inline { display: flex; gap: 8px; } form.inline input { margin: 0; }
  table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); }
  pre { overflow-x: auto; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; }
  a { color: var(--accent); }
</style>
</head>
<body>
${content}
</body>
</html>
`;
}
