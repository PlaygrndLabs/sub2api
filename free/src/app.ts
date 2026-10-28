import { hashKey, REFRESH_MARGIN_SECONDS, type Backend } from "./account.ts";
import type { Fetcher } from "./claude-oauth.ts";
import { claudeToGemini, geminiClaudeMessage, GeminiClaudeStream } from "./claude-gemini.ts";
import { chatClaudeMessage, ChatClaudeStream, claudeToChat } from "./claude-openai.ts";
import { claudeEventStream, claudeMessage, ClaudeStream, claudeToResponses } from "./claude-responses.ts";
import { chatCompletion, ChatStream, chatToClaude } from "./openai-claude.ts";
import { MANAGEMENT_PREFIX } from "./management.ts";
import { loginPage, messagePage } from "./pages.ts";
import { candidates, inDefaultFamily, listedModels, NATIVE_FORMAT, ordered, type Candidate, type Format, type RoutingTable } from "./providers.ts";
import { CODEX_UPSTREAM, codexRequest, downstreamResponse, formatError, presentedKey, providerRequest, routeOf, upstreamRequest, UPSTREAM, type Route } from "./proxy.ts";
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

// Per-isolate memory, so most API calls skip the Durable Object round trip entirely.
export class EdgeCache {
  readonly keys = new Map<string, number>();
  token: { value: string; name: string; expiresAt: number; cachedUntil: number } | null = null;
  codexToken: { value: string; name: string; accountId: string; expiresAt: number; cachedUntil: number } | null = null;
  routing: { table: RoutingTable; until: number } | null = null;
  turn = 0;
  usage: UsageRecord[] = [];
  flushing = false;

  // A config or login change reaches this isolate at once and others within a minute.
  forgetConfig(): void {
    this.keys.clear();
    this.routing = null;
    this.token = null;
    this.codexToken = null;
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
  const now = config.nowSeconds();
  if (cached !== null && cached.cachedUntil > now && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) return { token: cached.value };
  const result = await config.backend.token();
  if (!result.ok) return apiError(result.status, "api_error", result.message);
  config.cache.token = { value: result.accessToken, name: result.name ?? "", expiresAt: result.expiresAt, cachedUntil: now + TOKEN_CACHE_SECONDS };
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

async function codexAccess(config: AppConfig): Promise<{ token: string; accountId: string } | Response> {
  const cached = config.cache.codexToken;
  const now = config.nowSeconds();
  if (cached !== null && cached.cachedUntil > now && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) return { token: cached.value, accountId: cached.accountId };
  const result = await config.backend.codexToken();
  if (!result.ok) return formatError("openai-response", result.status, "api_error", result.message);
  const accountId = result.accountId ?? "";
  config.cache.codexToken = { value: result.accessToken, name: result.name ?? "", accountId, expiresAt: result.expiresAt, cachedUntil: now + TOKEN_CACHE_SECONDS };
  return { token: result.accessToken, accountId };
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
async function viaCodexLogin(request: Request, url: URL, config: AppConfig, text: string): Promise<Response> {
  const native = url.pathname === "/backend-api/codex/responses" || request.headers.has("originator");
  const prepared = codexBody(text, native);
  if (prepared === null) return formatError("openai-response", 400, "invalid_request_error", "The request body must be a JSON object.");
  const access = await codexAccess(config);
  if (access instanceof Response) return access;
  const upstream = await config.upstream(codexRequest(request, access.token, access.accountId, prepared.body)).catch(() => null);
  if (upstream === null) return formatError("openai-response", 502, "api_error", "ChatGPT couldn't be reached.");
  if (upstream.status === 401) {
    config.cache.codexToken = null;
    await config.backend.invalidate(access.token);
  }
  if (!upstream.ok || prepared.stream) return downstreamResponse(upstream);
  return collected(upstream);
}

// Formats a provider takes with translation: Claude clients can reach Responses, Chat and
// Gemini upstreams, and OpenAI Chat clients can reach Claude API keys.
function servable(format: Format, kind: Candidate["credential"]["kind"]): boolean {
  const native = NATIVE_FORMAT[kind];
  if (native === format) return true;
  if (format === "claude") return native === "openai-response" || native === "openai" || native === "gemini";
  return format === "openai" && native === "claude";
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
  const requested = typeof claude.model === "string" ? claude.model : candidate.model;
  const native = NATIVE_FORMAT[candidate.credential.kind];
  const translated = native === "openai" ? { ...claudeToChat(claude, candidate.model), toolNames: new Map<string, string>() } : native === "gemini" ? claudeToGemini(claude, candidate.model) : await claudeToResponses(claude, candidate.model);
  const body = JSON.stringify(translated.body);
  // The client's own headers describe a Claude request, so none of them go upstream.
  const bare = new Request(request.url, { method: "POST" });
  let upstream: Response | null;
  let accessToken = "";
  if (candidate.credential.id === CODEX_LOGIN_ID) {
    const access = await codexAccess(config);
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
    if (upstream.status === 401 && accessToken !== "") {
      config.cache.codexToken = null;
      await config.backend.invalidate(accessToken);
    }
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

// An OpenAI Chat request served by a Claude API key: the body is translated to Anthropic
// Messages, and the answer translated back, streamed or whole.
async function viaClaudeKey(request: Request, config: AppConfig, candidate: Candidate, text: string): Promise<Response> {
  const chat = parsedObject(text);
  if (chat === null) return formatError("openai", 400, "invalid_request_error", "The request body must be a JSON object.");
  const requested = typeof chat.model === "string" ? chat.model : candidate.model;
  const translated = chatToClaude(chat, candidate.model);
  // The client's own headers describe an OpenAI request, so none of them go upstream.
  const bare = new Request(request.url, { method: "POST" });
  const target = new URL("/v1/messages", request.url);
  const upstream = await config.upstream(providerRequest(bare, target, { method: "POST", format: "claude" }, candidate.credential, candidate.model, JSON.stringify(translated.body))).catch(() => null);
  if (upstream === null) return formatError("openai", 502, "api_error", "The upstream couldn't be reached.");
  if (!upstream.ok) return formatError("openai", upstream.status, upstream.status === 429 ? "rate_limit_error" : "api_error", await upstreamMessage(upstream));
  if (translated.stream && upstream.body !== null) {
    return new Response(claudeEventStream(upstream.body, new ChatStream(requested, translated.toolNames)), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  }
  const final = parsedObject(await upstream.text());
  if (final === null) return formatError("openai", 502, "api_error", "The upstream sent a response that isn't JSON.");
  return Response.json(chatCompletion(final, requested, translated.toolNames), { headers: { "cache-control": "no-store" } });
}

// Statuses after which another credential may well succeed.
const RETRY_STATUSES = new Set([401, 403, 408, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;
const CLAUDE_LOGIN_ID = "claude-login";
const CODEX_LOGIN_ID = "codex-login";

function loginCandidate(kind: "claude" | "codex", model: string): Candidate {
  const id = kind === "claude" ? CLAUDE_LOGIN_ID : CODEX_LOGIN_ID;
  const baseUrl = kind === "claude" ? UPSTREAM : CODEX_UPSTREAM;
  return { model, credential: { id, kind, group: "oauth", baseUrl, apiKey: "", weight: 1, priority: 0, prefix: "", headers: {}, models: [], excluded: [] } };
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
  let key: string | null = apiKeyKey(candidate.credential);
  if (candidate.credential.id === CLAUDE_LOGIN_ID) key = config.cache.token?.name ? loginKey(config.cache.token.name) : null;
  else if (candidate.credential.id === CODEX_LOGIN_ID) key = config.cache.codexToken?.name ? loginKey(config.cache.codexToken.name) : null;
  if (key !== null) trace.attempts.push({ key, ok: status < 400 });
}

async function proxied(request: Request, url: URL, route: Route & { format: Format }, config: AppConfig, trace: Trace): Promise<Response> {
  const table = await routingTable(config);
  // Claude clients with only Claude logins configured: stream the body through unread.
  if (route.format === "claude" && !table.codexOAuth && !table.credentials.some((credential) => servable("claude", credential.kind))) {
    const response = await viaClaudeLogin(request, url, config);
    noteAttempt(trace, config, loginCandidate("claude", ""), response.status);
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
  const usable = found.filter((candidate) => servable(route.format, candidate.credential.kind));
  if (route.format === "claude" && table.claudeOAuth && /^claude-/i.test(model)) usable.push(loginCandidate("claude", model));
  // ChatGPT logins take Codex's own models, and any Responses model nothing else serves.
  if (route.format === "openai-response" && table.codexOAuth && (inDefaultFamily("codex", model) || usable.length === 0)) usable.push(loginCandidate("codex", model));
  // Claude Code asking for a ChatGPT model by name, e.g. ANTHROPIC_MODEL=gpt-5.6-sol.
  if (route.format === "claude" && table.codexOAuth && inDefaultFamily("codex", model)) usable.push(loginCandidate("codex", model));
  if (usable.length === 0) {
    if (route.format === "claude" && table.claudeOAuth) {
      const response = await viaClaudeLogin(request, url, config, text);
      noteAttempt(trace, config, loginCandidate("claude", model), response.status);
      return response;
    }
    // Without CPA's cloaking a Claude login serves Claude Code only, so it isn't offered here.
    const reason =
      route.format === "openai" && table.claudeOAuth && /^claude-/i.test(model)
        ? `Claude logins serve Claude Code only. To use ${model} from an OpenAI client, add a Claude API key under AI Providers in the dashboard.`
        : found.length > 0
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
    const translated = route.format !== NATIVE_FORMAT[candidate.credential.kind];
    if (translated || candidate.credential.id === CLAUDE_LOGIN_ID || candidate.credential.id === CODEX_LOGIN_ID) {
      let response: Response;
      if (translated && route.format === "openai") response = await viaClaudeKey(request, config, candidate, text);
      else if (translated) response = await viaTranslation(request, url, route, config, candidate, text);
      else if (candidate.credential.id === CLAUDE_LOGIN_ID) response = await viaClaudeLogin(request, url, config, body);
      else response = await viaCodexLogin(request, url, config, body);
      noteAttempt(trace, config, candidate, response.status);
      if (isLast || !RETRY_STATUSES.has(response.status)) return response;
      await response.body?.cancel();
      last = new Response(null, { status: response.status });
      continue;
    }
    const upstream = await config.upstream(providerRequest(request, url, route, candidate.credential, candidate.model, body)).catch(() => null);
    noteAttempt(trace, config, candidate, upstream?.status ?? 502);
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
    const data = listed.filter((model) => model.kind !== "gemini").map((model) => ({ id: model.id, object: "model", created: 0, owned_by: model.kind }));
    return Response.json({ object: "list", data }, { headers });
  }
  const extra = listed.filter((model) => model.kind === "claude").map((model) => ({ type: "model", id: model.id, display_name: model.id, created_at: "1970-01-01T00:00:00Z" }));
  if (!table.claudeOAuth) return Response.json({ data: extra, has_more: false, first_id: extra[0]?.id ?? null, last_id: extra.at(-1)?.id ?? null }, { headers });
  const response = await viaClaudeLogin(request, url, config);
  if (!response.ok || extra.length === 0) return response;
  const body = (await response.json()) as { data?: unknown[] };
  return Response.json({ ...body, data: [...(body.data ?? []), ...extra] }, { headers });
}

// Sends the isolate's usage records to the Durable Object, a few seconds after the first one so
// that requests close together share one call.
function remember(config: AppConfig, record: UsageRecord): void {
  const cache = config.cache;
  if (config.waitUntil === undefined) return;
  cache.usage.push(record);
  const flush = async () => {
    const batch = cache.usage.splice(0);
    if (batch.length > 0) await config.backend.record(batch).catch(() => undefined);
  };
  if (cache.usage.length >= USAGE_FLUSH_COUNT) {
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
  if (route.format === "models") return modelList(request, url, config);
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
