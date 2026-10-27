import { DEFAULT_BASE_URL, type Format, type UpstreamCredential } from "./providers.ts";

export const UPSTREAM = "https://api.anthropic.com";
export const OAUTH_BETA = "oauth-2025-04-20";
export const CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex";
// What CPA sends for a ChatGPT login when the client doesn't say who it is.
const CODEX_ORIGINATOR = "codex-tui";
const CODEX_USER_AGENT = "codex-tui/0.154.0";
const CODEX_FORWARDED_HEADERS = new Set(["version", "session_id", "session-id", "thread-id", "x-client-request-id", "openai-beta", "originator"]);
const CODEX_FORWARDED_PREFIXES = ["x-codex-", "x-openai-internal-codex-"];

// The client-facing API endpoints, with the method and request shape each takes. Gemini's
// /v1beta/models/{model}:{action} is matched separately.
const ROUTES = new Map<string, { method: string; format: Format | "models" }>([
  ["/v1/messages", { method: "POST", format: "claude" }],
  ["/v1/messages/count_tokens", { method: "POST", format: "claude" }],
  ["/v1/models", { method: "GET", format: "models" }],
  ["/v1/chat/completions", { method: "POST", format: "openai" }],
  ["/v1/responses", { method: "POST", format: "openai-response" }],
  ["/backend-api/codex/responses", { method: "POST", format: "openai-response" }],
  ["/v1beta/models", { method: "GET", format: "models" }],
]);
const GEMINI_ACTION = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;

const FORWARDED_HEADERS = new Set(["accept", "content-type", "anthropic-version", "user-agent", "x-app"]);
const FORWARDED_PREFIXES = ["x-stainless-", "x-claude-code-"];
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "connection", "keep-alive", "transfer-encoding"]);

export interface Route {
  readonly method: string;
  readonly format: Format | "models";
  // For Gemini, the model and action come from the path.
  readonly geminiModel?: string;
  readonly geminiAction?: string;
}

export function routeOf(pathname: string): Route | null {
  const fixed = ROUTES.get(pathname);
  if (fixed !== undefined) return fixed;
  const gemini = GEMINI_ACTION.exec(pathname);
  if (gemini === null) return null;
  return { method: "POST", format: "gemini", geminiModel: decodeURIComponent(gemini[1] ?? ""), geminiAction: gemini[2] ?? "" };
}

export function isProxied(pathname: string): boolean {
  return routeOf(pathname) !== null;
}

// Clients send the gateway key the way their own SDK sends a provider key.
export function presentedKey(request: Request, url: URL): string | null {
  const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim();
  return bearer || request.headers.get("x-api-key")?.trim() || request.headers.get("x-goog-api-key")?.trim() || url.searchParams.get("key")?.trim() || null;
}

// The query string without the gateway key, which Gemini clients may send as ?key=.
function forwardedSearch(url: URL): string {
  if (!url.searchParams.has("key")) return url.search;
  const search = new URLSearchParams(url.search);
  search.delete("key");
  const query = search.toString();
  return query === "" ? "" : `?${query}`;
}

function forwardedHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARDED_HEADERS.has(name) || FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix))) headers.set(name, value);
  }
  return headers;
}

// The request body is a stream handed straight to Anthropic: it is never read or parsed here,
// which keeps CPU time flat however large the conversation is.
export function upstreamRequest(request: Request, url: URL, accessToken: string, body?: BodyInit): Request {
  const headers = forwardedHeaders(request);
  const betas = (request.headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta !== "");
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  headers.set("anthropic-beta", betas.join(","));
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  headers.set("authorization", `Bearer ${accessToken}`);
  const target = `${UPSTREAM}${url.pathname}${forwardedSearch(url)}`;
  if (body !== undefined) return new Request(target, { method: request.method, headers, body });
  return new Request(new Request(target, request), { headers });
}

// Configured headers apply last. A value starting with "$" copies that header from the client
// request, or leaves it out when the client didn't send it, as in CPA.
function applyConfiguredHeaders(headers: Headers, credential: UpstreamCredential, request: Request): void {
  for (const [name, value] of Object.entries(credential.headers)) {
    if (value.startsWith("$")) {
      const copied = request.headers.get(value.slice(1));
      if (copied !== null) headers.set(name, copied);
    } else {
      headers.set(name, value);
    }
  }
}

// The request for an API-key provider in its own format. `body` is the client body, with the
// model already swapped for the upstream name when they differ.
export function providerRequest(request: Request, url: URL, route: Route, credential: UpstreamCredential, model: string, body: BodyInit | null): Request {
  const headers = forwardedHeaders(request);
  let target: string;
  switch (credential.kind) {
    case "claude": {
      if (request.headers.has("anthropic-beta")) headers.set("anthropic-beta", request.headers.get("anthropic-beta") ?? "");
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
      // Anthropic itself takes x-api-key; other Claude-compatible gateways take a bearer token.
      if (credential.baseUrl === DEFAULT_BASE_URL.claude) headers.set("x-api-key", credential.apiKey);
      else headers.set("authorization", `Bearer ${credential.apiKey}`);
      target = `${credential.baseUrl}${url.pathname}${forwardedSearch(url)}`;
      break;
    }
    case "gemini":
      headers.set("x-goog-api-key", credential.apiKey);
      target = `${credential.baseUrl}/v1beta/models/${encodeURIComponent(model)}:${route.geminiAction ?? "generateContent"}${forwardedSearch(url)}`;
      break;
    case "codex":
      headers.set("authorization", `Bearer ${credential.apiKey}`);
      target = `${credential.baseUrl}/responses`;
      break;
    case "openai-compatibility":
      headers.set("authorization", `Bearer ${credential.apiKey}`);
      target = `${credential.baseUrl}/chat/completions`;
      break;
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  applyConfiguredHeaders(headers, credential, request);
  return new Request(target, { method: "POST", headers, body });
}

// A Responses request for a ChatGPT (Codex) subscription login. The access token and the
// ChatGPT account it belongs to replace whatever the client sent.
export function codexRequest(request: Request, accessToken: string, accountId: string, body: string): Request {
  const headers = forwardedHeaders(request);
  for (const [name, value] of request.headers) {
    if (CODEX_FORWARDED_HEADERS.has(name) || CODEX_FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix))) headers.set(name, value);
  }
  headers.delete("anthropic-version");
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  headers.set("authorization", `Bearer ${accessToken}`);
  if (accountId !== "") headers.set("chatgpt-account-id", accountId);
  if (!headers.has("originator")) headers.set("originator", CODEX_ORIGINATOR);
  if (!headers.has("user-agent")) headers.set("user-agent", CODEX_USER_AGENT);
  return new Request(`${CODEX_UPSTREAM}/responses`, { method: "POST", headers, body });
}

export function downstreamResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) if (!DROPPED_RESPONSE_HEADERS.has(name)) headers.set(name, value);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

// An error in the shape the client's own SDK expects for its format.
export function formatError(format: Format | "models", status: number, type: string, message: string): Response {
  const headers = { "cache-control": "no-store" };
  switch (format) {
    case "claude":
      return Response.json({ type: "error", error: { type, message } }, { status, headers });
    case "gemini":
      return Response.json({ error: { code: status, message, status: geminiStatus(status) } }, { status, headers });
    default:
      return Response.json({ error: { message, type, code: null } }, { status, headers });
  }
}

function geminiStatus(status: number): string {
  if (status === 400) return "INVALID_ARGUMENT";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 404) return "NOT_FOUND";
  if (status === 405) return "METHOD_NOT_ALLOWED";
  if (status === 429) return "RESOURCE_EXHAUSTED";
  return "UNAVAILABLE";
}
