import { hashKey, REFRESH_MARGIN_SECONDS, type Backend, type ServedLogin } from "./account.ts";
import type { Fetcher } from "./claude-oauth.ts";
import { claudeToGemini, geminiClaudeMessage, GeminiClaudeStream } from "./claude-gemini.ts";
import { chatClaudeMessage, ChatClaudeStream, claudeToChat } from "./claude-openai.ts";
import { claudeEventStream, claudeMessage, ClaudeStream, claudeToResponses, type EventTranslator, type Json } from "./claude-responses.ts";
import { chatCompletion, ChatStream, chatToClaude } from "./openai-claude.ts";
import { geminiResponse, GeminiStream, geminiToClaude } from "./gemini-claude.ts";
import { kimiUpstreamModel } from "./kimi-oauth.ts";
import { responsesResponse, ResponsesStream, responsesToClaude } from "./responses-claude.ts";
import { codexModelCatalog } from "./codex-models.ts";
import { MANAGEMENT_PREFIX } from "./management.ts";
import { CatalogCache, claudeModelList, geminiModel, geminiModelList, openaiModelList, servedModels } from "./models.ts";
import { loginPage, messagePage } from "./pages.ts";
import { candidates, inDefaultFamily, NATIVE_FORMAT, splitModel, takesNatively, type Candidate, type Format, type LoginEntry, type RoutingTable } from "./providers.ts";
import { CODEX_UPSTREAM, codexRequest, downstreamResponse, formatError, presentedKey, providerRequest, routeOf, upstreamRequest, UPSTREAM, type Route } from "./proxy.ts";
import { CooldownBook, retryHint, route as routed, type CooldownEvent } from "./routing.ts";
import { apiKeyKey, loginKey, requestLine, type Attempt, type UsageRecord } from "./usage.ts";
import { SESSION_COOKIE, SESSION_SECONDS, issueSession, passwordMatches, readCookie, readSmallForm, sessionIsValid } from "./session.ts";

export const MIN_PASSWORD_LENGTH = 16;
export const MIN_MANAGEMENT_KEY_LENGTH = MIN_PASSWORD_LENGTH;
const KEY_CACHE_SECONDS = 60;
// Short, so a login disabled or removed in the dashboard stops being used within a minute in
// every isolate, and round-robin across logins still turns.
const TOKEN_CACHE_SECONDS = 60;
const MAX_FORM_BODY = 4096;
// Workers accept request bodies up to 100 MB; a larger declared body is refused before reading.
const MAX_BODY = 32 * 1024 * 1024;
const PASSWORD_NOT_SET = `Sign-in is off: set the DASHBOARD_PASSWORD secret to at least ${MIN_PASSWORD_LENGTH} characters.`;
// Usage records wait this long in the isolate, so a burst of requests costs one Durable Object call.
const USAGE_FLUSH_MS = 5000;
const USAGE_FLUSH_COUNT = 50;
const OAUTH_CALLBACK_PATHS = new Set(["/callback", "/auth/callback", "/oauth-callback", "/anthropic/callback", "/codex/callback"]);

export interface CachedToken {
  readonly value: string;
  // The login file the token belongs to.
  readonly name: string;
  readonly accountId: string;
  readonly expiresAt: number;
  readonly cachedUntil: number;
}

// Per-isolate memory, so most API calls skip the Durable Object round trip entirely.
export class EdgeCache {
  readonly keys = new Map<string, number>();
  // Login tokens by "<provider>:<login name>"; the name is empty for "the next login in turn".
  readonly tokens = new Map<string, CachedToken>();
  readonly logins = new Map<ServedLogin, { value: string; name: string; endpoint: string; headers: Record<string, string>; expiresAt: number; cachedUntil: number }>();
  routing: { table: RoutingTable; until: number } | null = null;
  readonly cooldowns = new CooldownBook();
  readonly catalog = new CatalogCache();
  turn = 0;
  usage: UsageRecord[] = [];
  cooling: CooldownEvent[] = [];
  flushing = false;

  // A config or login change reaches this isolate at once and others within a minute.
  forgetConfig(): void {
    this.keys.clear();
    this.routing = null;
    this.tokens.clear();
    this.cooldowns.clear();
    this.logins.clear();
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
  // Keeps the isolate alive for work after the response, such as sending usage records.
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly usageFlushMs?: number;
  // Waits between retry rounds; tests pass their own.
  readonly sleep?: (ms: number) => Promise<void>;
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

function tokenKey(provider: LoginEntry["provider"], name: string): string {
  return `${provider}:${name}`;
}

// A login's token from this isolate's cache, or from the Durable Object, which keeps it fresh.
// An empty name asks for the next login in turn.
async function loginToken(config: AppConfig, provider: LoginEntry["provider"], name: string): Promise<CachedToken | { status: number; message: string }> {
  const key = tokenKey(provider, name);
  const cached = config.cache.tokens.get(key);
  const now = config.nowSeconds();
  if (cached !== undefined && cached.cachedUntil > now && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) return cached;
  const login = name === "" ? undefined : name;
  const result = await (provider === "claude" ? config.backend.token(login) : config.backend.codexToken(login));
  if (!result.ok) return { status: result.status, message: result.message };
  const token = { value: result.accessToken, name: result.name ?? name, accountId: result.accountId ?? "", expiresAt: result.expiresAt, cachedUntil: now + TOKEN_CACHE_SECONDS };
  config.cache.tokens.set(key, token);
  return token;
}

// The provider refused the token: drop it here and have the Durable Object refresh it.
async function refused(config: AppConfig, provider: LoginEntry["provider"], name: string, token: string): Promise<void> {
  config.cache.tokens.delete(tokenKey(provider, name));
  await config.backend.invalidate(token);
}

// A Claude subscription login, through the OAuth token the Durable Object keeps fresh.
async function viaClaudeLogin(request: Request, url: URL, config: AppConfig, body?: string, name = ""): Promise<Response> {
  const token = await loginToken(config, "claude", name);
  if (!("value" in token)) return apiError(token.status, "api_error", token.message);
  const upstream = await config.upstream(upstreamRequest(request, url, token.value, body)).catch(() => null);
  if (upstream === null) return apiError(502, "api_error", "Anthropic couldn't be reached.");
  if (upstream.status === 401) await refused(config, "claude", name, token.value);
  return downstreamResponse(upstream);
}

async function codexAccess(config: AppConfig, name = ""): Promise<{ token: string; accountId: string } | Response> {
  const token = await loginToken(config, "codex", name);
  if (!("value" in token)) return formatError("openai-response", token.status, "api_error", token.message);
  return { token: token.value, accountId: token.accountId };
}

// A login's token and where its requests go, kept fresh by the Durable Object.
interface LoginAccess {
  readonly token: string;
  readonly endpoint: string;
  readonly headers: Record<string, string>;
}

async function loginAccess(config: AppConfig, provider: ServedLogin): Promise<LoginAccess | { status: number; message: string }> {
  const cached = config.cache.logins.get(provider);
  const now = config.nowSeconds();
  if (cached !== undefined && cached.cachedUntil > now && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) return { token: cached.value, endpoint: cached.endpoint, headers: cached.headers };
  const result = await config.backend.loginToken(provider);
  if (!result.ok) return { status: result.status, message: result.message };
  const endpoint = result.endpoint ?? "";
  const headers = result.headers ?? {};
  config.cache.logins.set(provider, { value: result.accessToken, name: result.name ?? "", endpoint, headers, expiresAt: result.expiresAt, cachedUntil: now + TOKEN_CACHE_SECONDS });
  return { token: result.accessToken, endpoint, headers };
}

// Fields the ChatGPT Codex endpoint refuses, which other Responses clients may send (as CPA strips).
const CODEX_DROPPED_FIELDS = new Set(["previous_response_id", "generate", "prompt_cache_retention", "safety_identifier", "stream_options", "max_output_tokens", "max_completion_tokens", "temperature"]);

// The Codex endpoint only streams and never stores. Codex CLI's own requests already fit and go
// through untouched; other Responses clients' bodies are adjusted, and their non-streaming
// requests answered from the stream's final event.
function codexBody(text: string, native: boolean): { body: string; stream: boolean } | null {
  if (native) return { body: text, stream: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = Object.entries(parsed).filter(([key]) => !CODEX_DROPPED_FIELDS.has(key));
  const body: Record<string, unknown> = { ...Object.fromEntries(fields), stream: true, store: false };
  body.instructions ??= "";
  return { body: JSON.stringify(body), stream: (parsed as Record<string, unknown>).stream === true };
}

const FINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

// The final response object from a Codex event stream, for a client that didn't ask to stream.
async function collected(upstream: Response): Promise<Response> {
  const lines = (await upstream.text()).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("data:") || !line.includes('"response.')) continue;
    let event: { type?: unknown; response?: { error?: { message?: unknown } } };
    try {
      event = JSON.parse(line.slice(5)) as typeof event;
    } catch {
      continue;
    }
    if (typeof event.type !== "string" || !FINAL_EVENTS.has(event.type)) continue;
    if (event.type === "response.failed") {
      const message = typeof event.response?.error?.message === "string" ? event.response.error.message : "The response failed upstream.";
      return formatError("openai-response", 502, "api_error", message);
    }
    return Response.json(event.response, { headers: { "cache-control": "no-store" } });
  }
  return formatError("openai-response", 502, "api_error", "The upstream stream ended without a final response.");
}

// A ChatGPT (Codex) subscription login, through the OAuth token the Durable Object keeps fresh.
async function viaCodexLogin(request: Request, url: URL, config: AppConfig, text: string, name = ""): Promise<Response> {
  const native = url.pathname === "/backend-api/codex/responses" || request.headers.has("originator");
  const prepared = codexBody(text, native);
  if (prepared === null) return formatError("openai-response", 400, "invalid_request_error", "The request body must be a JSON object.");
  const access = await codexAccess(config, name);
  if (access instanceof Response) return access;
  const upstream = await config.upstream(codexRequest(request, access.token, access.accountId, prepared.body)).catch(() => null);
  if (upstream === null) return formatError("openai-response", 502, "api_error", "ChatGPT couldn't be reached.");
  if (upstream.status === 401) await refused(config, "codex", name, access.token);
  if (!upstream.ok || prepared.stream) return downstreamResponse(upstream);
  return collected(upstream);
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The message an upstream error carries, whichever shape it came in.
async function upstreamMessage(upstream: Response): Promise<string> {
  const body = parsedObject(await upstream.text().catch(() => ""));
  const error = body?.error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  if (typeof body?.detail === "string") return body.detail;
  return `The upstream answered ${upstream.status}.`;
}

// A Claude request served by a Responses upstream (a ChatGPT login or a Codex key), a Chat
// Completions one (an OpenAI-compatible key) or Gemini (a Gemini key): the body is translated,
// and the answer translated back, streamed or whole.
async function viaTranslation(request: Request, url: URL, route: Route, config: AppConfig, candidate: Candidate, text: string): Promise<Response> {
  const claude = parsedObject(text);
  if (claude === null) return formatError("claude", 400, "invalid_request_error", "The request body must be a JSON object.");
  if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: Math.ceil(text.length / 4) }, { headers: { "cache-control": "no-store" } });
  return translatedClaude(request, route, config, candidate, claude);
}

async function translatedClaude(request: Request, route: Route, config: AppConfig, candidate: Candidate, claude: Json): Promise<Response> {
  const url = new URL(request.url);
  const requested = typeof claude.model === "string" ? claude.model : candidate.model;
  const native = NATIVE_FORMAT[candidate.credential.kind];
  const translated = native === "openai" ? { ...claudeToChat(claude, candidate.model), toolNames: new Map<string, string>() } : native === "gemini" ? claudeToGemini(claude, candidate.model) : await claudeToResponses(claude, candidate.model);
  const body = JSON.stringify(translated.body);
  // The client's own headers describe a Claude request, so none of them go upstream.
  const bare = new Request(request.url, { method: "POST" });
  let upstream: Response | null;
  let accessToken = "";
  const login = loginName(candidate);
  if (login !== null) {
    const access = await codexAccess(config, login);
    if (access instanceof Response) return formatError("claude", access.status, "api_error", await upstreamMessage(access));
    accessToken = access.token;
    upstream = await config.upstream(codexRequest(bare, access.token, access.accountId, body)).catch(() => null);
  } else if (native === "gemini") {
    const geminiRoute: Route = { ...route, format: "gemini", geminiAction: translated.stream ? "streamGenerateContent" : "generateContent" };
    const target = new URL(request.url);
    target.search = translated.stream ? "?alt=sse" : "";
    upstream = await config.upstream(providerRequest(bare, target, geminiRoute, candidate.credential, candidate.model, body)).catch(() => null);
  } else {
    const upstreamRoute: Route = { ...route, format: native };
    upstream = await config.upstream(providerRequest(bare, url, upstreamRoute, candidate.credential, candidate.model, body)).catch(() => null);
  }
  if (upstream === null) return formatError("claude", 502, "api_error", "The upstream couldn't be reached.");
  if (!upstream.ok) {
    if (upstream.status === 401 && accessToken !== "") await refused(config, "codex", login ?? "", accessToken);
    return formatError("claude", upstream.status, upstream.status === 429 ? "rate_limit_error" : "api_error", await upstreamMessage(upstream));
  }
  if (translated.stream && upstream.body !== null) {
    const translator = native === "openai" ? new ChatClaudeStream(requested) : native === "gemini" ? new GeminiClaudeStream(requested, translated.toolNames) : new ClaudeStream(requested, translated.toolNames);
    return new Response(claudeEventStream(upstream.body, translator), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  }
  if (native === "openai" || native === "gemini") {
    const final = parsedObject(await upstream.text());
    if (final === null) return formatError("claude", 502, "api_error", "The upstream sent a response that isn't JSON.");
    const message = native === "openai" ? chatClaudeMessage(final, requested) : geminiClaudeMessage(final, requested, translated.toolNames);
    return Response.json(message, { headers: { "cache-control": "no-store" } });
  }
  const final = await collected(upstream);
  if (!final.ok) return formatError("claude", final.status, "api_error", await upstreamMessage(final));
  return Response.json(claudeMessage((await final.json()) as Record<string, unknown>, requested, translated.toolNames), { headers: { "cache-control": "no-store" } });
}

// An OpenAI Chat, Responses or Gemini request: the body is translated to Anthropic Messages and sent
// to a Claude API key, or translated on to the candidate's own format; the answer comes back
// the same way, streamed or whole.
async function viaClaudeMessages(request: Request, url: URL, route: Route & { format: Format }, config: AppConfig, candidate: Candidate, text: string): Promise<Response> {
  const client = parsedObject(text);
  if (client === null) return formatError(route.format, 400, "invalid_request_error", "The request body must be a JSON object.");
  const requested = route.geminiModel ?? (typeof client.model === "string" ? client.model : candidate.model);
  if (route.geminiAction === "countTokens") return Response.json({ totalTokens: Math.ceil(text.length / 4) }, { headers: { "cache-control": "no-store" } });
  const translated =
    route.format === "openai-response"
      ? responsesToClaude(client, candidate.model)
      : route.format === "gemini"
      ? { ...geminiToClaude(client, candidate.model, route.geminiAction === "streamGenerateContent"), customTools: new Set<string>() }
      : { ...chatToClaude(client, candidate.model), customTools: new Set<string>() };
  let upstream: Response | null;
  if (NATIVE_FORMAT[candidate.credential.kind] === "claude") {
    // The client's own headers describe an OpenAI request, so none of them go upstream.
    const bare = new Request(request.url, { method: "POST" });
    const target = new URL("/v1/messages", request.url);
    upstream = await config.upstream(providerRequest(bare, target, { method: "POST", format: "claude" }, candidate.credential, candidate.model, JSON.stringify(translated.body))).catch(() => null);
  } else {
    upstream = await translatedClaude(new Request(new URL("/v1/messages", url), { method: "POST" }), { method: "POST", format: "claude" }, config, candidate, translated.body);
  }
  if (upstream === null) return formatError(route.format, 502, "api_error", "The upstream couldn't be reached.");
  if (!upstream.ok) return formatError(route.format, upstream.status, upstream.status === 429 ? "rate_limit_error" : "api_error", await upstreamMessage(upstream));
  if (translated.stream && upstream.body !== null) {
    // Gemini streams SSE only with ?alt=sse, and a JSON array otherwise.
    const sse = route.format !== "gemini" || url.searchParams.get("alt") === "sse";
    const translator: EventTranslator =
      route.format === "openai-response"
        ? new ResponsesStream(requested, translated.toolNames, translated.customTools)
        : route.format === "gemini"
        ? new GeminiStream(requested, translated.toolNames, sse)
        : new ChatStream(requested, translated.toolNames);
    return new Response(claudeEventStream(upstream.body, translator), { headers: { "content-type": sse ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-cache" } });
  }
  const final = parsedObject(await upstream.text());
  if (final === null) return formatError(route.format, 502, "api_error", "The upstream sent a response that isn't JSON.");
  const answer =
    route.format === "openai-response"
      ? responsesResponse(final, requested, translated.toolNames, translated.customTools)
      : route.format === "gemini"
      ? geminiResponse(final, requested, translated.toolNames)
      : chatCompletion(final, requested, translated.toolNames);
  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}

// A login is a candidate of its own, with id "file:<login name>" as in the usage counts.
const LOGIN_GROUP = "oauth";

function loginCandidate(login: LoginEntry, model: string): Candidate {
  const baseUrl = login.provider === "claude" ? UPSTREAM : CODEX_UPSTREAM;
  return {
    model,
    credential: {
      id: loginKey(login.name),
      kind: login.provider,
      group: LOGIN_GROUP,
      baseUrl,
      apiKey: "",
      weight: login.weight,
      priority: login.priority,
      prefix: login.prefix,
      headers: {},
      models: [],
      excluded: [],
      disableCooling: login.disableCooling,
      requestRetry: login.requestRetry,
    },
  };
}

// The login file a candidate uses ("" for the next login in turn), or null for an API key.
function loginName(candidate: Candidate): string | null {
  return candidate.credential.group === LOGIN_GROUP ? candidate.credential.id.slice("file:".length) : null;
}

// Each enabled login. A table without the list (an older Durable Object) stands for one login per
// provider, which the Durable Object then picks in turn.
function anyLogin(provider: LoginEntry["provider"]): LoginEntry {
  return { name: "", provider, priority: 0, weight: 1, prefix: "", disableCooling: null, requestRetry: null };
}

function loginsOf(table: RoutingTable): readonly LoginEntry[] {
  if (table.logins !== undefined) return table.logins;
  return [...(table.claudeOAuth ? [anyLogin("claude")] : []), ...(table.codexOAuth ? [anyLogin("codex")] : [])];
}

// Kimi and Vertex logins are served like an API key of their provider, once their endpoint and
// token are known. The Durable Object picks one in turn, so they are one candidate per provider.
const SERVED_GROUP = "oauth-served";

function servedCandidate(kind: ServedLogin, model: string): Candidate {
  // Without per-login candidates, a cooldown would rest every login of the provider, so none is set.
  return { model, credential: { id: `${kind}-login`, kind, group: SERVED_GROUP, baseUrl: "", apiKey: "", weight: 1, priority: 0, prefix: "", headers: {}, models: [], excluded: [], disableCooling: true, requestRetry: null } };
}

function servedOf(candidate: Candidate): ServedLogin | null {
  if (candidate.credential.group !== SERVED_GROUP) return null;
  return candidate.credential.kind === "kimi" || candidate.credential.kind === "vertex" ? candidate.credential.kind : null;
}

async function servedLogin(config: AppConfig, candidate: Candidate, provider: ServedLogin): Promise<{ candidate: Candidate; token: string } | { status: number; message: string }> {
  const access = await loginAccess(config, provider);
  if (!("token" in access)) return access;
  return { token: access.token, candidate: { ...candidate, credential: { ...candidate.credential, baseUrl: access.endpoint, headers: { ...access.headers, authorization: `Bearer ${access.token}` } } } };
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

// What a request was served with, for its log line and the credentials' usage counts.
interface Trace {
  readonly attempts: Attempt[];
  provider: string;
  model: string;
}

function noteAttempt(trace: Trace, config: AppConfig, candidate: Candidate, status: number): void {
  trace.provider = candidate.credential.kind;
  const login = loginName(candidate);
  let key: string | null = login === null ? apiKeyKey(candidate.credential) : loginKey(login);
  if (login === "") {
    const name = config.cache.tokens.get(tokenKey(candidate.credential.kind === "codex" ? "codex" : "claude", ""))?.name;
    key = name ? loginKey(name) : null;
  } else {
    const served = servedOf(candidate);
    if (served !== null) {
      const name = config.cache.logins.get(served)?.name ?? "";
      key = name === "" ? null : loginKey(name);
    }
  }
  if (key !== null) trace.attempts.push({ key, ok: status < 400 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Error bodies are read for a wait hint only while small.
const HINT_BODY_LIMIT = 64 * 1024;

async function proxied(request: Request, url: URL, route: Route & { format: Format }, config: AppConfig, trace: Trace): Promise<Response> {
  const table = await routingTable(config);
  const logins = loginsOf(table);
  const claudeLogins = logins.filter((login) => login.provider === "claude");
  const codexLogins = logins.filter((login) => login.provider === "codex");
  // Claude clients with one Claude login and nothing else: stream the body through unread.
  if (route.format === "claude" && claudeLogins.length === 1 && codexLogins.length === 0 && !table.vertexOAuth && !table.kimiOAuth && table.credentials.length === 0) {
    const only = loginCandidate(claudeLogins[0] as LoginEntry, "");
    const response = await viaClaudeLogin(request, url, config, undefined, loginName(only) ?? "");
    noteAttempt(trace, config, only, response.status);
    return response;
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY) return formatError(route.format, 413, "invalid_request_error", "Request body too large.");
  const text = await request.text();
  const parsed = route.format === "gemini" ? null : requestBody(text);
  const model = route.geminiModel ?? parsed?.model ?? null;
  if (model === null) return formatError(route.format, 400, "invalid_request_error", "The request needs a model.");
  trace.model = model;
  const found = candidates(table, model);
  // Every client format reaches every provider: Claude requests are translated to the
  // provider's format, and the others through Anthropic Messages.
  const usable = [...found];
  // "prefix/model" picks the logins with that prefix; other names may use any login.
  const { prefix, model: bare } = splitModel(table, model);
  const loginsFor = (provider: LoginEntry["provider"]) => (provider === "claude" ? claudeLogins : codexLogins).filter((login) => prefix === "" || login.prefix === prefix).map((login) => loginCandidate(login, bare));
  if (route.format === "claude" && /^claude-/i.test(bare)) usable.push(...loginsFor("claude"));
  // ChatGPT logins take Codex's own models, and any Responses model nothing else serves.
  if (route.format === "openai-response" && (inDefaultFamily("codex", bare) || usable.length === 0)) usable.push(...loginsFor("codex"));
  // Claude Code or a Chat client asking for a ChatGPT model by name, e.g. ANTHROPIC_MODEL=gpt-5.6-sol.
  if ((route.format === "claude" || route.format === "openai") && inDefaultFamily("codex", bare)) usable.push(...loginsFor("codex"));
  // Vertex service accounts take Gemini models, from any client, translated where needed.
  if (table.vertexOAuth === true && inDefaultFamily("vertex", model)) usable.push(servedCandidate("vertex", model));
  // Kimi logins take Kimi's models in Anthropic and both OpenAI formats untranslated, and
  // Gemini clients through Anthropic Messages.
  if (table.kimiOAuth === true && inDefaultFamily("kimi", model)) usable.push(servedCandidate("kimi", kimiUpstreamModel(model)));
  if (usable.length === 0) {
    if (route.format === "claude" && table.claudeOAuth) {
      const response = await viaClaudeLogin(request, url, config, text);
      noteAttempt(trace, config, loginCandidate(anyLogin("claude"), model), response.status);
      return response;
    }
    // Without CPA's cloaking a Claude login serves Claude Code only, so it isn't offered here.
    const reason =
      route.format !== "claude" && table.claudeOAuth && /^claude-/i.test(model)
        ? `Claude logins serve Claude Code only. To use ${model} from another client, add a Claude API key under AI Providers in the dashboard.`
        : `No provider is configured for model ${model}. Add one under AI Providers in the dashboard.`;
    return formatError(route.format, 400, "invalid_request_error", reason);
  }
  // One attempt with one candidate, through the path its provider and the request format need.
  const serveWith = async (attempt: Candidate, attemptConfig: AppConfig): Promise<Response> => {
    let candidate = attempt;
    let servedToken = "";
    const served = servedOf(attempt);
    if (served !== null) {
      const resolved = await servedLogin(attemptConfig, attempt, served);
      if (!("token" in resolved)) return formatError(route.format, resolved.status, "api_error", resolved.message);
      candidate = resolved.candidate;
      servedToken = resolved.token;
    }
    const body = parsed === null || candidate.model === model ? text : parsed.withModel(candidate.model);
    const translated = !takesNatively(candidate.credential.kind, route.format);
    const login = loginName(candidate);
    let response: Response;
    if (translated && route.format !== "claude") response = await viaClaudeMessages(request, url, route, attemptConfig, candidate, text);
    else if (translated) response = await viaTranslation(request, url, route, attemptConfig, candidate, text);
    else if (login !== null && candidate.credential.kind === "claude") response = await viaClaudeLogin(request, url, attemptConfig, body, login);
    else if (login !== null) response = await viaCodexLogin(request, url, attemptConfig, body, login);
    else {
      const upstream = await attemptConfig.upstream(providerRequest(request, url, route, candidate.credential, candidate.model, body)).catch(() => null);
      response = upstream === null ? formatError(route.format, 502, "api_error", "The upstream couldn't be reached.") : downstreamResponse(upstream);
    }
    // The provider refused a served login's token: the Durable Object gets a new one, at most once a minute.
    if (response.status === 401 && served !== null) {
      config.cache.logins.delete(served);
      await config.backend.invalidate(servedToken);
    }
    return response;
  };
  // The first request in an isolate starts at the first credential, as CPA's rotation does.
  const turn = config.cache.turn;
  config.cache.turn += 1;
  return routed({
    table,
    usable,
    turn,
    book: config.cache.cooldowns,
    nowSeconds: config.nowSeconds,
    sleep: config.sleep ?? sleep,
    isLogin: (candidate) => loginName(candidate) !== null,
    attempt: async (candidate) => {
      // The upstream's own answer carries the wait hint, whatever shape the client gets back.
      let hint: Promise<number | null> = Promise.resolve(null);
      const watched: AppConfig = {
        ...config,
        upstream: async (upstreamRequest) => {
          const upstream = await config.upstream(upstreamRequest);
          if (upstream.status === 429 || upstream.status === 404 || upstream.status >= 500) {
            const small = Number(upstream.headers.get("content-length") ?? "0") <= HINT_BODY_LIMIT;
            const body = upstream.status === 429 && small ? upstream.clone().text().catch(() => "") : Promise.resolve("");
            hint = body.then((text) => retryHint(upstream.headers, text.slice(0, HINT_BODY_LIMIT), config.nowSeconds()));
          }
          return upstream;
        },
      };
      const response = await serveWith(candidate, watched);
      noteAttempt(trace, config, candidate, response.status);
      return { response, hint: response.ok ? null : await hint };
    },
    report: (event) => share(config, event),
    cooling: (seconds) => {
      const response = formatError(route.format, 429, "rate_limit_error", `Every credential for model ${model} is cooling down after errors or rate limits. Try again in ${Math.max(1, seconds)} s, or reset the cooldowns in the dashboard.`);
      response.headers.set("retry-after", String(Math.max(1, seconds)));
      return response;
    },
  });
}

async function modelList(request: Request, url: URL, route: Route, config: AppConfig): Promise<Response> {
  const table = await routingTable(config);
  // CPA's catalog refreshes after the response, so no request waits for it.
  const refreshing = config.cache.catalog.refresh(config.upstream, config.nowSeconds());
  if (refreshing !== null) config.waitUntil?.(refreshing);
  const served = servedModels(table, config.cache.catalog.current(), config.nowSeconds());
  const headers = { "cache-control": "no-store" };
  // The Codex CLI's own catalog format, which it asks for when model_catalog_url points here.
  if (url.pathname === "/v1/models" && url.searchParams.has("client_version")) {
    return new Response(codexModelCatalog(served, url.searchParams.get("client_version") ?? ""), { headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  }
  const models = served.map((entry) => entry.model);
  if (route.geminiModel !== undefined) {
    const found = models.find((model) => model.id === route.geminiModel);
    if (found === undefined) return formatError("gemini", 404, "not_found", `Model ${route.geminiModel} isn't served here.`);
    return Response.json(geminiModel(found), { headers });
  }
  if (url.pathname === "/v1beta/models") return Response.json(geminiModelList(models), { headers });
  // Anthropic SDKs and Claude Code get Anthropic's shape, as in CPA; everyone else OpenAI's.
  const anthropic = request.headers.has("anthropic-version") || (request.headers.get("user-agent") ?? "").startsWith("claude-cli");
  return Response.json(anthropic ? claudeModelList(models) : openaiModelList(models), { headers });
}

// Sends the isolate's usage records and cooldowns to the Durable Object, a few seconds after the
// first one so that requests close together share one call.
function flushSoon(config: AppConfig): void {
  const cache = config.cache;
  if (config.waitUntil === undefined) return;
  const flush = async () => {
    const batch = cache.usage.splice(0);
    const cooling = cache.cooling.splice(0);
    if (batch.length > 0) await config.backend.record(batch).catch(() => undefined);
    if (cooling.length > 0) await config.backend.cool(cooling).catch(() => undefined);
  };
  if (cache.usage.length + cache.cooling.length >= USAGE_FLUSH_COUNT) {
    config.waitUntil(flush());
    return;
  }
  if (cache.flushing) return;
  cache.flushing = true;
  config.waitUntil(
    new Promise((resolve) => setTimeout(resolve, config.usageFlushMs ?? USAGE_FLUSH_MS))
      .then(flush)
      .finally(() => {
        cache.flushing = false;
      }),
  );
}

function remember(config: AppConfig, record: UsageRecord): void {
  if (config.waitUntil === undefined) return;
  config.cache.usage.push(record);
  flushSoon(config);
}

function share(config: AppConfig, event: CooldownEvent): void {
  if (config.waitUntil === undefined) return;
  config.cache.cooling.push(event);
  flushSoon(config);
}

function requestId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

async function api(request: Request, url: URL, route: Route, config: AppConfig): Promise<Response> {
  const started = Date.now();
  const trace: Trace = { attempts: [], provider: "", model: route.geminiModel ?? "" };
  const response = await served(request, url, route, config, trace);
  const line = requestLine({
    at: started,
    requestId: requestId(),
    status: response.status,
    ms: Date.now() - started,
    ip: request.headers.get("cf-connecting-ip") ?? "",
    method: request.method,
    // The query is left out: Gemini clients may put their key in it.
    path: url.pathname,
    provider: trace.provider,
    model: trace.model,
  });
  remember(config, { at: started, line, attempts: trace.attempts });
  return response;
}

async function served(request: Request, url: URL, route: Route, config: AppConfig, trace: Trace): Promise<Response> {
  if (request.method !== route.method) return formatError(route.format, 405, "invalid_request_error", "Method not allowed.");
  const key = presentedKey(request, url);
  if (key === null || !(await keyValid(key, config))) {
    return formatError(route.format, 401, "authentication_error", "Invalid API key. Add one under API Keys in the gateway dashboard.");
  }
  if (route.format === "models") return modelList(request, url, route, config);
  return proxied(request, url, route as Route & { format: Format }, config, trace);
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

// As on the container install, the management key is its own secret: the dashboard keeps it in
// browser storage, so it must never be the sign-in password.
const MANAGEMENT_KEY_NOT_SET = `The management API is off: set the MANAGEMENT_KEY secret to at least ${MIN_MANAGEMENT_KEY_LENGTH} characters, different from DASHBOARD_PASSWORD.`;

function managementEnabled(config: AppConfig): boolean {
  return config.managementKey.length >= MIN_MANAGEMENT_KEY_LENGTH && config.managementKey !== config.dashboardPassword;
}

// The dashboard sends CPA's management key with every call, on top of the sign-in cookie.
async function managementKeyValid(request: Request, config: AppConfig): Promise<boolean> {
  if (!managementEnabled(config)) return false;
  const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim();
  const given = bearer || request.headers.get("x-management-key")?.trim() || "";
  return given !== "" && passwordMatches(given, config.managementKey);
}

async function management(request: Request, url: URL, config: AppConfig): Promise<Response> {
  if (!(await signedIn(request, config))) return Response.json({ error: "sign in at /login first" }, { status: 401 });
  if (!managementEnabled(config)) return Response.json({ error: MANAGEMENT_KEY_NOT_SET }, { status: 503 });
  if (!(await managementKeyValid(request, config))) return Response.json({ error: "invalid management key" }, { status: 401 });
  // The dashboard checks a server with v0's config read before switching to v8.
  const target = url.pathname === "/v0/management/config" ? new URL(`${MANAGEMENT_PREFIX}/config${url.search}`, url) : url;
  const response = await config.backend.manage(withoutCookies(request, target));
  // A write may change providers, remove a key or a login, so this isolate checks again at once.
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
      return (await signedIn(request, config)) ? panel(request, config) : redirect("/login");
    default:
      return notFound();
  }
}
