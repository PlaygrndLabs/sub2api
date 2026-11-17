// The sign-in gate is the only login. Once signed in, the dashboard sends this placeholder as its
// management key and the gateway swaps in the real one server-side, so the key never reaches the
// browser. The placeholder is no secret: only a request with a valid session cookie gets swapped.
export const PLACEHOLDER_KEY = "sub2api-session";

// The dashboard calls the management API with "Authorization: Bearer <key>". Requiring the header
// keeps a cross-site form, which cannot set it, away from the API even if a cookie were sent.
export function hasManagementHeader(request: Request): boolean {
  return request.headers.has("authorization") || request.headers.has("x-management-key");
}

// The browser's key is dropped and the server's key goes in its place.
export function withManagementKey(headers: Headers, key: string): Headers {
  const next = new Headers(headers);
  next.delete("cookie");
  next.delete("x-management-key");
  next.set("authorization", `Bearer ${key}`);
  return next;
}

// Runs before the dashboard's own code. It writes the dashboard's saved session (store
// "cli-proxy-auth", "enc::v2::" = base64 of the JSON XOR "cli-proxy-api-webui::secure-storage|<host>")
// with the placeholder key, so the dashboard skips its key prompt. If a new dashboard release changes
// that format, the dashboard just shows its own prompt, and any text typed there works. When the
// dashboard logs out after having logged in, the gate's session ends too.
const SCRIPT = `(() => {
  try {
    const host = location.host;
    const mask = new TextEncoder().encode("cli-proxy-api-webui::secure-storage|" + host);
    const plain = new TextEncoder().encode(JSON.stringify({ state: { apiBase: location.origin, managementKey: ${JSON.stringify(PLACEHOLDER_KEY)}, rememberPassword: true }, version: 0 }));
    let binary = "";
    plain.forEach((byte, index) => { binary += String.fromCharCode(byte ^ mask[index % mask.length]); });
    localStorage.setItem("cli-proxy-auth", "enc::v2::" + btoa(binary));
    localStorage.setItem("isLoggedIn", "true");
    let loggedIn = false;
    const setItem = Storage.prototype.setItem;
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === "isLoggedIn" && value === "true") loggedIn = true;
      return setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      const result = removeItem.call(this, key);
      if (loggedIn && this === localStorage && key === "isLoggedIn") location.replace("/logout");
      return result;
    };
  } catch {}
})();`;

const TAG = `<script>${SCRIPT}</script>`;

// Puts the script first in <head>. Without a <head> the page is served unchanged.
export function withAutoLogin(html: string): string {
  const match = /<head(\s[^>]*)?>/i.exec(html);
  if (match === null) return html;
  const end = match.index + match[0].length;
  return `${html.slice(0, end)}${TAG}${html.slice(end)}`;
}

// Asks for the whole, uncompressed page, so the script can be added.
export function plainPageRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of ["cookie", "authorization", "x-management-key", "accept-encoding", "range", "if-range", "if-none-match", "if-modified-since"]) headers.delete(name);
  return new Request(request.url, { method: request.method, headers });
}

// Adds the script to a full HTML page and serves it uncached and never framed: it is third-party
// code that runs with the session. Anything else (an error, a compressed body) passes unchanged.
export async function dashboardPage(response: Response): Promise<Response> {
  const encoding = response.headers.get("content-encoding");
  const html = (response.headers.get("content-type") ?? "").includes("text/html");
  const rewrite = response.status === 200 && response.body !== null && html && (encoding === null || encoding === "identity");
  const headers = new Headers(response.headers);
  if (rewrite) {
    for (const name of ["content-length", "content-encoding", "etag", "last-modified", "accept-ranges", "content-range"]) headers.delete(name);
  }
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", "frame-ancestors 'none'");
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  const body = rewrite ? withAutoLogin(await response.text()) : response.body;
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
