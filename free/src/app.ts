import { hashKey, REFRESH_MARGIN_SECONDS, type Backend } from "./account.ts";
import type { Fetcher } from "./claude-oauth.ts";
import { MANAGEMENT_PREFIX } from "./management.ts";
import { loginPage, messagePage } from "./pages.ts";
import { candidates, listedModels, NATIVE_FORMAT, ordered, type Candidate, type Format, type RoutingTable } from "./providers.ts";
import { downstreamResponse, formatError, presentedKey, providerRequest, routeOf, upstreamRequest, UPSTREAM, type Route } from "./proxy.ts";
import { SESSION_COOKIE, SESSION_SECONDS, issueSession, passwordMatches, readCookie, sessionIsValid } from "./session.ts";

export const MIN_PASSWORD_LENGTH = 16;
export const MIN_MANAGEMENT_KEY_LENGTH = MIN_PASSWORD_LENGTH;
const KEY_CACHE_SECONDS = 60;
const MAX_FORM_BODY = 4096;
// Workers accept request bodies up to 100 MB; a larger declared body is refused before reading.
const MAX_BODY = 32 * 1024 * 1024;
const PASSWORD_NOT_SET = `Sign-in is off: set the DASHBOARD_PASSWORD secret to at least ${MIN_PASSWORD_LENGTH} characters.`;
const OAUTH_CALLBACK_PATHS = new Set(["/callback", "/auth/callback", "/oauth-callback", "/anthropic/callback"]);

// Per-isolate memory, so most API calls skip the Durable Object round trip entirely.
export class EdgeCache {
  readonly keys = new Map<string, number>();
  token: { value: string; expiresAt: number } | null = null;
  routing: { table: RoutingTable; until: number } | null = null;
  turn = 0;

  // Config changes reach this isolate at once and others within a minute.
  forgetConfig(): void {
    this.keys.clear();
    this.routing = null;
  }
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
  return formatError("claude", status, type, message);
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

async function routingTable(config: AppConfig): Promise<RoutingTable> {
  const cached = config.cache.routing;
  if (cached !== null && cached.until > config.nowSeconds()) return cached.table;
  const table = await config.backend.routing();
  config.cache.routing = { table, until: config.nowSeconds() + KEY_CACHE_SECONDS };
  return table;
}

async function accessToken(config: AppConfig): Promise<{ token: string } | Response> {
  const cached = config.cache.token;
  if (cached !== null && cached.expiresAt - config.nowSeconds() > REFRESH_MARGIN_SECONDS) return { token: cached.value };
  const result = await config.backend.token();
  if (!result.ok) return apiError(result.status, "api_error", result.message);
  config.cache.token = { value: result.accessToken, expiresAt: result.expiresAt };
  return { token: result.accessToken };
}

// A Claude subscription login, through the OAuth token the Durable Object keeps fresh.
async function viaClaudeLogin(request: Request, url: URL, config: AppConfig, body?: string): Promise<Response> {
  const token = await accessToken(config);
  if (token instanceof Response) return token;
  const upstream = await config.upstream(upstreamRequest(request, url, token.token, body)).catch(() => null);
  if (upstream === null) return apiError(502, "api_error", "Anthropic couldn't be reached.");
  if (upstream.status === 401) {
    config.cache.token = null;
    await config.backend.invalidate(token.token);
  }
  return downstreamResponse(upstream);
}

// Statuses after which another credential may well succeed.
const RETRY_STATUSES = new Set([401, 403, 408, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;
const CLAUDE_LOGIN_ID = "claude-login";

function claudeLoginCandidate(model: string): Candidate {
  return {
    model,
    credential: { id: CLAUDE_LOGIN_ID, kind: "claude", group: "oauth", baseUrl: UPSTREAM, apiKey: "", weight: 1, priority: 0, prefix: "", headers: {}, models: [], excluded: [] },
  };
}

// Most clients put "model" first. Then it is read and replaced in place, without parsing the
// rest of a body that can run to megabytes; otherwise the body is parsed once.
const LEADING_MODEL = /^\s*\{\s*"model"\s*:\s*("(?:[^"\\]|\\.)*")/;

interface RequestBody {
  readonly text: string;
  readonly model: string | null;
  withModel(model: string): string;
}

function requestBody(text: string): RequestBody {
  const leading = LEADING_MODEL.exec(text.slice(0, 4096));
  if (leading !== null) {
    const raw = leading[1] ?? '""';
    const end = leading[0].length;
    const start = end - raw.length;
    const value = JSON.parse(raw) as string;
    return { text, model: value.trim() === "" ? null : value.trim(), withModel: (model) => `${text.slice(0, start)}${JSON.stringify(model)}${text.slice(end)}` };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const model = typeof parsed?.model === "string" && parsed.model.trim() !== "" ? parsed.model.trim() : null;
  return { text, model, withModel: (next) => JSON.stringify({ ...parsed, model: next }) };
}

async function proxied(request: Request, url: URL, route: Route & { format: Format }, config: AppConfig): Promise<Response> {
  const table = await routingTable(config);
  // Claude clients with only subscription logins configured: stream the body through unread.
  if (route.format === "claude" && !table.credentials.some((credential) => credential.kind === "claude")) {
    return viaClaudeLogin(request, url, config);
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY) return formatError(route.format, 413, "invalid_request_error", "Request body too large.");
  const text = await request.text();
  const parsed = route.format === "gemini" ? null : requestBody(text);
  const model = route.geminiModel ?? parsed?.model ?? null;
  if (model === null) return formatError(route.format, 400, "invalid_request_error", "The request needs a model.");
  const found = candidates(table, model);
  const usable = found.filter((candidate) => NATIVE_FORMAT[candidate.credential.kind] === route.format);
  if (route.format === "claude" && table.claudeOAuth && /^claude-/i.test(model)) usable.push(claudeLoginCandidate(model));
  if (usable.length === 0) {
    if (route.format === "claude" && table.claudeOAuth) return viaClaudeLogin(request, url, config, text);
    const reason =
      found.length > 0
        ? `Model ${model} is served by a ${found[0]?.credential.kind} provider, which doesn't take this request format yet.`
        : `No provider is configured for model ${model}. Add one under AI Providers in the dashboard.`;
    return formatError(route.format, 400, "invalid_request_error", reason);
  }
  config.cache.turn += 1;
  const attempts = ordered(usable, config.cache.turn).slice(0, MAX_ATTEMPTS);
  let last: Response | null = null;
  for (const [index, candidate] of attempts.entries()) {
    const isLast = index === attempts.length - 1;
    const body = parsed === null || candidate.model === model ? text : parsed.withModel(candidate.model);
    if (candidate.credential.id === CLAUDE_LOGIN_ID) {
      const response = await viaClaudeLogin(request, url, config, body);
      if (isLast || !RETRY_STATUSES.has(response.status)) return response;
      await response.body?.cancel();
      last = new Response(null, { status: response.status });
      continue;
    }
    const upstream = await config.upstream(providerRequest(request, url, route, candidate.credential, candidate.model, body)).catch(() => null);
    if (upstream !== null && (isLast || !RETRY_STATUSES.has(upstream.status))) return downstreamResponse(upstream);
    if (upstream !== null) {
      await upstream.body?.cancel();
      last = new Response(null, { status: upstream.status });
    }
  }
  return formatError(route.format, last?.status ?? 502, "api_error", "No provider could serve the request right now.");
}

async function modelList(request: Request, url: URL, config: AppConfig): Promise<Response> {
  const table = await routingTable(config);
  const listed = listedModels(table);
  const headers = { "cache-control": "no-store" };
  if (url.pathname === "/v1beta/models") {
    const models = listed.filter((model) => model.kind === "gemini").map((model) => ({ name: `models/${model.id}`, displayName: model.id, supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"] }));
    return Response.json({ models }, { headers });
  }
  // Anthropic SDKs and Claude Code get Anthropic's shape, as in CPA; everyone else OpenAI's.
  const anthropic = request.headers.has("anthropic-version") || (request.headers.get("user-agent") ?? "").startsWith("claude-cli");
  if (!anthropic) {
    const data = listed.filter((model) => model.kind !== "claude" && model.kind !== "gemini").map((model) => ({ id: model.id, object: "model", created: 0, owned_by: model.kind }));
    return Response.json({ object: "list", data }, { headers });
  }
  const extra = listed.filter((model) => model.kind === "claude").map((model) => ({ type: "model", id: model.id, display_name: model.id, created_at: "1970-01-01T00:00:00Z" }));
  if (!table.claudeOAuth) return Response.json({ data: extra, has_more: false, first_id: extra[0]?.id ?? null, last_id: extra.at(-1)?.id ?? null }, { headers });
  const response = await viaClaudeLogin(request, url, config);
  if (!response.ok || extra.length === 0) return response;
  const body = (await response.json()) as { data?: unknown[] };
  return Response.json({ ...body, data: [...(body.data ?? []), ...extra] }, { headers });
}

async function api(request: Request, url: URL, route: Route, config: AppConfig): Promise<Response> {
  if (request.method !== route.method) return formatError(route.format, 405, "invalid_request_error", "Method not allowed.");
  const key = presentedKey(request, url);
  if (key === null || !(await keyValid(key, config))) {
    return formatError(route.format, 401, "authentication_error", "Invalid API key. Add one under API Keys in the gateway dashboard.");
  }
  if (route.format === "models") return modelList(request, url, config);
  return proxied(request, url, route as Route & { format: Format }, config);
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
  const length = Number(request.headers.get("content-length") ?? "0");
  const form = Number.isFinite(length) && length <= MAX_FORM_BODY ? await request.formData().catch(() => null) : null;
  const password = form?.get("password");
  if (typeof password !== "string" || !(await passwordMatches(password, config.dashboardPassword))) {
    return html(loginPage("Wrong password."), 401);
  }
  const token = await issueSession(config.dashboardPassword, config.nowSeconds());
  return redirect("/management.html", { "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}` });
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
  // Config, logins and keys all feed the cached routing table.
  if (request.method !== "GET") config.cache.forgetConfig();
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
    config.cache.forgetConfig();
    return html(messagePage("Login received", "Go back to the dashboard to see the new login.", false));
  }
  const reason = typeof body?.error === "string" ? body.error : `the gateway answered ${response.status}`;
  return html(messagePage("Login not saved", `${reason}. Start the login again from the dashboard.`, true), response.ok ? 400 : response.status);
}

export async function handle(request: Request, config: AppConfig): Promise<Response> {
  const url = new URL(request.url);
  const route = routeOf(url.pathname);
  if (route !== null) return api(request, url, route, config);
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
      return (await signedIn(request, config)) ? config.panel(request) : redirect("/login");
    default:
      return notFound();
  }
}
