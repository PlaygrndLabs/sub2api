import { hashKey, REFRESH_MARGIN_SECONDS, type Backend } from "./account.ts";
import type { Fetcher } from "./claude-oauth.ts";
import { MANAGEMENT_PREFIX } from "./management.ts";
import { loginPage, messagePage } from "./pages.ts";
import { downstreamResponse, isProxied, methodAllowed, presentedKey, upstreamRequest } from "./proxy.ts";
import { SESSION_COOKIE, SESSION_SECONDS, issueSession, passwordMatches, readCookie, readSmallForm, sessionIsValid } from "./session.ts";

export const MIN_PASSWORD_LENGTH = 16;
export const MIN_MANAGEMENT_KEY_LENGTH = MIN_PASSWORD_LENGTH;
const KEY_CACHE_SECONDS = 60;
// Short, so a login disabled or removed in the dashboard stops being used within a minute in
// every isolate, and round-robin across logins still turns.
const TOKEN_CACHE_SECONDS = 60;
const MAX_FORM_BODY = 4096;
const PASSWORD_NOT_SET = `Sign-in is off: set the DASHBOARD_PASSWORD secret to at least ${MIN_PASSWORD_LENGTH} characters.`;
const OAUTH_CALLBACK_PATHS = new Set(["/callback", "/auth/callback", "/oauth-callback", "/anthropic/callback"]);

// Per-isolate memory, so most API calls skip the Durable Object round trip entirely.
export class EdgeCache {
  readonly keys = new Map<string, number>();
  token: { value: string; expiresAt: number; cachedUntil: number } | null = null;
}

export interface AppConfig {
  readonly backend: Backend;
  readonly dashboardPassword: string;
  readonly managementKey: string;
  readonly nowSeconds: () => number;
  readonly upstream: Fetcher;
  readonly panel: (request: Request) => Promise<Response>;
  readonly cache: EdgeCache;
}

function apiError(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status, headers: { "cache-control": "no-store" } });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      ...headers,
    },
  });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function keyValid(key: string, config: AppConfig): Promise<boolean> {
  const hash = await hashKey(key);
  const now = config.nowSeconds();
  const cachedUntil = config.cache.keys.get(hash);
  if (cachedUntil !== undefined && cachedUntil > now) return true;
  if (!(await config.backend.keyValid(hash))) return false;
  config.cache.keys.set(hash, now + KEY_CACHE_SECONDS);
  return true;
}

async function accessToken(config: AppConfig): Promise<{ token: string } | Response> {
  const cached = config.cache.token;
  const now = config.nowSeconds();
  if (cached !== null && cached.cachedUntil > now && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) return { token: cached.value };
  const result = await config.backend.token();
  if (!result.ok) return apiError(result.status, "api_error", result.message);
  config.cache.token = { value: result.accessToken, expiresAt: result.expiresAt, cachedUntil: now + TOKEN_CACHE_SECONDS };
  return { token: result.accessToken };
}

async function api(request: Request, url: URL, config: AppConfig): Promise<Response> {
  if (!methodAllowed(url.pathname, request.method)) return apiError(405, "invalid_request_error", "Method not allowed.");
  const key = presentedKey(request);
  if (key === null || !(await keyValid(key, config))) {
    return apiError(401, "authentication_error", "Invalid API key. Add one under API Keys in the gateway dashboard.");
  }
  const token = await accessToken(config);
  if (token instanceof Response) return token;
  const upstream = await config.upstream(upstreamRequest(request, url, token.token)).catch(() => null);
  if (upstream === null) return apiError(502, "api_error", "Anthropic couldn't be reached.");
  if (upstream.status === 401) {
    config.cache.token = null;
    await config.backend.invalidate(token.token);
  }
  return downstreamResponse(upstream);
}

async function signedIn(request: Request, config: AppConfig): Promise<boolean> {
  if (config.dashboardPassword.length < MIN_PASSWORD_LENGTH) return false;
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return token !== null && (await sessionIsValid(config.dashboardPassword, token, config.nowSeconds()));
}

// Browsers send Origin on every form POST, though some send "null" under a strict referrer
// policy; Sec-Fetch-Site then still says whether the form came from this site.
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin === url.origin) return true;
  return (origin === null || origin === "null") && request.headers.get("sec-fetch-site") === "same-origin";
}

async function login(request: Request, config: AppConfig): Promise<Response> {
  if (config.dashboardPassword.length < MIN_PASSWORD_LENGTH) return html(loginPage(PASSWORD_NOT_SET), 503);
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await config.backend.attemptAllowed(client))) return html(loginPage("Too many sign-in attempts. Wait a minute and try again."), 429);
  const form = await readSmallForm(request, MAX_FORM_BODY).catch(() => null);
  const password = form?.get("password");
  if (typeof password !== "string" || !(await passwordMatches(password, config.dashboardPassword))) {
    return html(loginPage("Wrong password."), 401);
  }
  const token = await issueSession(config.dashboardPassword, config.nowSeconds());
  return redirect("/management.html", { "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}` });
}

// The dashboard is third-party HTML that holds the management key, so it is never framed.
async function panel(request: Request, config: AppConfig): Promise<Response> {
  const response = await config.panel(request);
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "frame-ancestors 'none'");
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withoutCookies(request: Request, target?: URL): Request {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return new Request(target ?? request.url, new Request(request, { headers }));
}

// The dashboard sends CPA's management key with every call, on top of the sign-in cookie.
async function managementKeyValid(request: Request, config: AppConfig): Promise<boolean> {
  if (config.managementKey.length < MIN_MANAGEMENT_KEY_LENGTH) return false;
  const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim();
  const given = bearer || request.headers.get("x-management-key")?.trim() || "";
  return given !== "" && passwordMatches(given, config.managementKey);
}

async function management(request: Request, url: URL, config: AppConfig): Promise<Response> {
  if (config.managementKey.length < MIN_MANAGEMENT_KEY_LENGTH) return notFound();
  if (!(await signedIn(request, config))) return Response.json({ error: "sign in at /login first" }, { status: 401 });
  if (!(await managementKeyValid(request, config))) return Response.json({ error: "invalid management key" }, { status: 401 });
  // The dashboard checks a server with v0's config read before switching to v8.
  const target = url.pathname === "/v0/management/config" ? new URL(`${MANAGEMENT_PREFIX}/config${url.search}`, url) : url;
  const response = await config.backend.manage(withoutCookies(request, target));
  // A write may remove a key or a login, so this isolate checks again at once.
  if (request.method !== "GET") {
    config.cache.keys.clear();
    config.cache.token = null;
  }
  return response;
}

async function oauthCallback(request: Request, url: URL, config: AppConfig): Promise<Response> {
  if (request.method !== "GET") return notFound();
  if (!(await signedIn(request, config))) {
    return html(messagePage("Sign in first", "Sign in to the dashboard, then open this address again.", true), 401);
  }
  const target = new URL(`${MANAGEMENT_PREFIX}/oauth/callback${url.search}`, url);
  const response = await config.backend.manage(new Request(target));
  const body = (await response.json().catch(() => null)) as { status?: unknown; error?: unknown } | null;
  if (response.ok && body?.status === "ok") {
    config.cache.token = null;
    return html(messagePage("Login received", "Go back to the dashboard to see the new login.", false));
  }
  const reason = typeof body?.error === "string" ? body.error : `the gateway answered ${response.status}`;
  return html(messagePage("Login not saved", `${reason}. Start the login again from the dashboard.`, true), response.ok ? 400 : response.status);
}

export async function handle(request: Request, config: AppConfig): Promise<Response> {
  const url = new URL(request.url);
  if (isProxied(url.pathname)) return api(request, url, config);
  if (url.pathname.startsWith(`${MANAGEMENT_PREFIX}/`) || url.pathname === MANAGEMENT_PREFIX || url.pathname === "/v0/management/config") {
    return management(request, url, config);
  }
  if (OAUTH_CALLBACK_PATHS.has(url.pathname)) return oauthCallback(request, url, config);
  switch (url.pathname) {
    case "/healthz":
      return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    case "/login":
      if (request.method === "POST") return sameOrigin(request, url) ? login(request, config) : notFound();
      if (request.method === "GET") return html(loginPage(config.dashboardPassword.length < MIN_PASSWORD_LENGTH ? PASSWORD_NOT_SET : null));
      return notFound();
    case "/logout":
      if (request.method !== "POST" && request.method !== "GET") return notFound();
      return redirect("/login", { "set-cookie": `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
    case "/":
      if (request.method !== "GET") return notFound();
      return redirect((await signedIn(request, config)) ? "/management.html" : "/login");
    case "/management.html":
      if (request.method !== "GET") return notFound();
      return (await signedIn(request, config)) ? panel(request, config) : redirect("/login");
    default:
      return notFound();
  }
}
