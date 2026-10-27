import { hashKey, REFRESH_MARGIN_SECONDS, type Backend } from "./account.ts";
import type { Fetcher } from "./claude-oauth.ts";
import { dashboardPage, loginPage, type DashboardView } from "./pages.ts";
import { downstreamResponse, isProxied, methodAllowed, presentedKey, upstreamRequest } from "./proxy.ts";
import { SESSION_COOKIE, SESSION_SECONDS, issueSession, passwordMatches, readCookie, sessionIsValid } from "../../src/session.ts";

export const MIN_PASSWORD_LENGTH = 16;
const KEY_CACHE_SECONDS = 60;
const MAX_FORM_BODY = 4096;
const PASSWORD_NOT_SET = `Sign-in is off: set the DASHBOARD_PASSWORD secret to at least ${MIN_PASSWORD_LENGTH} characters.`;

// Per-isolate memory, so most API calls skip the Durable Object round trip entirely.
export class EdgeCache {
  readonly keys = new Map<string, number>();
  token: { value: string; expiresAt: number } | null = null;
}

export interface AppConfig {
  readonly backend: Backend;
  readonly dashboardPassword: string;
  readonly nowSeconds: () => number;
  readonly upstream: Fetcher;
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
      "referrer-policy": "no-referrer",
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
  if (cached !== null && cached.expiresAt - config.nowSeconds() > REFRESH_MARGIN_SECONDS) return { token: cached.value };
  const result = await config.backend.token();
  if (!result.ok) return apiError(result.status, "api_error", result.message);
  config.cache.token = { value: result.accessToken, expiresAt: result.expiresAt };
  return { token: result.accessToken };
}

async function api(request: Request, url: URL, config: AppConfig): Promise<Response> {
  if (!methodAllowed(url.pathname, request.method)) return apiError(405, "invalid_request_error", "Method not allowed.");
  const key = presentedKey(request);
  if (key === null || !(await keyValid(key, config))) {
    return apiError(401, "authentication_error", "Invalid API key. Create one in the gateway dashboard.");
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

async function readForm(request: Request): Promise<FormData | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_FORM_BODY) return null;
  return request.formData().catch(() => null);
}

// Browsers send Origin on every form POST; a missing or foreign one is not our dashboard.
function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}

async function login(request: Request, config: AppConfig): Promise<Response> {
  if (config.dashboardPassword.length < MIN_PASSWORD_LENGTH) return html(loginPage(PASSWORD_NOT_SET), 503);
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await config.backend.attemptAllowed(client))) return html(loginPage("Too many sign-in attempts. Wait a minute and try again."), 429);
  const form = await readForm(request);
  const password = form?.get("password");
  if (typeof password !== "string" || !(await passwordMatches(password, config.dashboardPassword))) {
    return html(loginPage("Wrong password."), 401);
  }
  const token = await issueSession(config.dashboardPassword, config.nowSeconds());
  return redirect("/", { "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}` });
}

async function dashboard(url: URL, config: AppConfig, extra: Partial<DashboardView> = {}, status = 200): Promise<Response> {
  const overview = await config.backend.overview();
  return html(dashboardPage({ overview, origin: url.origin, nowSeconds: config.nowSeconds(), ...extra }), status);
}

async function dashboardAction(request: Request, url: URL, config: AppConfig): Promise<Response> {
  const form = await readForm(request);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === "string" ? value : "";
  };
  switch (field("action")) {
    case "create-key":
      return dashboard(url, config, { newKey: await config.backend.createKey(field("name")) });
    case "revoke-key": {
      const id = Number(field("id"));
      if (Number.isInteger(id)) await config.backend.revokeKey(id);
      return redirect("/");
    }
    case "start-login":
      return dashboard(url, config, { loginUrl: await config.backend.startLogin() });
    case "finish-login": {
      const error = await config.backend.finishLogin(field("callback"));
      config.cache.token = null;
      return error === null ? dashboard(url, config, { message: "Claude account connected." }) : dashboard(url, config, { error }, 400);
    }
    case "disconnect":
      await config.backend.disconnect();
      config.cache.token = null;
      return redirect("/");
    default:
      return dashboard(url, config, { error: "Unknown action." }, 400);
  }
}

export async function handle(request: Request, config: AppConfig): Promise<Response> {
  const url = new URL(request.url);
  if (isProxied(url.pathname)) return api(request, url, config);
  switch (url.pathname) {
    case "/healthz":
      return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    case "/login":
      if (request.method === "POST") return sameOrigin(request, url) ? login(request, config) : notFound();
      if (request.method === "GET") return html(loginPage(config.dashboardPassword.length < MIN_PASSWORD_LENGTH ? PASSWORD_NOT_SET : null));
      return notFound();
    case "/logout":
      if (request.method !== "POST") return notFound();
      return redirect("/login", { "set-cookie": `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
    case "/":
      if (request.method !== "GET") return notFound();
      return (await signedIn(request, config)) ? dashboard(url, config) : redirect("/login");
    case "/dashboard":
      if (request.method !== "POST" || !sameOrigin(request, url)) return notFound();
      if (!(await signedIn(request, config))) return redirect("/login");
      return dashboardAction(request, url, config);
    default:
      return notFound();
  }
}
