import type { Overview } from "./account.ts";

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function loginPage(error: string | null): string {
  return page(`<section class="narrow">
  <h1>sub2api</h1>
  <p class="muted">Sign in to manage your gateway.</p>
  ${notice(error, true)}
  <form method="post" action="/login">
    <input type="password" name="password" autocomplete="current-password" placeholder="Dashboard password" required autofocus>
    <button type="submit">Sign in</button>
  </form>
</section>`);
}

export interface DashboardView {
  readonly overview: Overview;
  readonly origin: string;
  readonly nowSeconds: number;
  readonly message?: string | null;
  readonly error?: string | null;
  readonly newKey?: string | null;
  readonly loginUrl?: string | null;
}

export function dashboardPage(view: DashboardView): string {
  const { account, keys } = view.overview;
  const accountBlock =
    account === null
      ? `<p>No Claude account connected yet.</p>`
      : `<p>Connected as <strong>${escapeHtml(account.email || "your Claude account")}</strong>. The access token renews itself; this one is good for ${minutesLeft(account.expiresAt, view.nowSeconds)}.</p>
  <form method="post" action="/dashboard"><input type="hidden" name="action" value="disconnect"><button class="secondary" type="submit">Disconnect</button></form>`;
  const loginBlock =
    view.loginUrl == null
      ? `<form method="post" action="/dashboard"><input type="hidden" name="action" value="start-login"><button type="submit">${account === null ? "Connect Claude" : "Connect again"}</button></form>`
      : `<ol>
    <li><a href="${escapeHtml(view.loginUrl)}" target="_blank" rel="noopener noreferrer">Open Claude's sign-in page</a> and approve.</li>
    <li>You land on a <code>localhost</code> page that doesn't load. That's expected. Copy its whole address.</li>
    <li>Paste it here within 15 minutes.</li>
  </ol>
  <form method="post" action="/dashboard"><input type="hidden" name="action" value="finish-login">
    <input name="callback" placeholder="http://localhost:54545/callback?code=..." required autocomplete="off">
    <button type="submit">Save login</button>
  </form>`;
  const rows = keys
    .map(
      (key) => `<tr><td>${escapeHtml(key.name)}</td><td><code>…${escapeHtml(key.hint)}</code></td><td>${new Date(key.createdAt * 1000).toISOString().slice(0, 10)}</td>
      <td><form method="post" action="/dashboard"><input type="hidden" name="action" value="revoke-key"><input type="hidden" name="id" value="${key.id}"><button class="secondary" type="submit">Revoke</button></form></td></tr>`,
    )
    .join("");
  const newKey =
    view.newKey == null
      ? ""
      : `<div class="notice">Copy this key now. It won't be shown again.<pre>${escapeHtml(view.newKey)}</pre></div>`;
  return page(`<section>
  <header><h1>sub2api</h1><form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form></header>
  ${notice(view.message ?? null, false)}${notice(view.error ?? null, true)}
  <h2>Claude account</h2>
  ${accountBlock}
  ${loginBlock}
  <h2>API keys</h2>
  ${newKey}
  ${keys.length === 0 ? "<p>No keys yet. API calls are refused until you create one.</p>" : `<table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table>`}
  <form method="post" action="/dashboard" class="inline"><input type="hidden" name="action" value="create-key">
    <input name="name" placeholder="Key name, e.g. laptop" maxlength="60" autocomplete="off"><button type="submit">Create key</button>
  </form>
  <h2>Use it</h2>
  <pre>export ANTHROPIC_BASE_URL=${escapeHtml(view.origin)}
export ANTHROPIC_API_KEY=&lt;your gateway API key&gt;</pre>
  <p class="muted">A revoked key can keep working for up to a minute.</p>
</section>`);
}

function minutesLeft(expiresAt: number, nowSeconds: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - nowSeconds) / 60));
  return minutes >= 120 ? `${Math.round(minutes / 60)} more hours` : `${minutes} more minutes`;
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
