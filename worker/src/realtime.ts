// OpenAI Realtime (voice) for ChatGPT (Codex) logins, as CPA serves it: a Realtime WebSocket goes
// to OpenAI's Realtime API, and a WebRTC call offer goes to ChatGPT's Codex call endpoint, both
// with the login's token. Audio never passes through the Worker: the WebSocket is handed to the
// runtime as is, and WebRTC media flows between the client and OpenAI.

export const REALTIME_UPSTREAM = "https://api.openai.com/v1/realtime";
export const CODEX_CALLS_UPSTREAM = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
// The model ChatGPT logins serve voice with; CPA maps every gpt-realtime model to it.
export const LIVE_MODEL = "gpt-live-1-codex";
const DEFAULT_SOCKET_MODEL = "gpt-realtime";
// What CPA sends on a Realtime WebSocket when the client doesn't say who it is.
const SOCKET_ORIGINATOR = "Codex Desktop";
// SDP offers are a few kilobytes.
export const MAX_CALL_BODY = 1024 * 1024;
// Only the Realtime protocol headers go upstream, never the client's own credentials.
const PROTOCOL_HEADERS = ["openai-alpha", "x-session-id", "session-id", "thread-id", "originator", "openai-safety-identifier", "openai-organization", "openai-project", "x-oai-attestation"];
const CALL_RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id", "openai-request-id"];
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Browsers put an API key in a WebSocket subprotocol; the gateway key must not reach OpenAI.
const KEY_SUBPROTOCOL = /^openai-insecure-api-key\./i;

export type RealtimeRoute = "socket" | "call" | "unsupported";

// CPA's Realtime routes. The WebSocket and the WebRTC call are served; client secrets, sideband
// sockets, SIP control and translations need state the Worker doesn't keep yet.
export function realtimeRoute(method: string, pathname: string, search: URLSearchParams): RealtimeRoute | null {
  if (pathname === "/v1/realtime") {
    if (method === "GET") return search.has("call_id") ? "unsupported" : "socket";
    return method === "POST" ? "call" : null;
  }
  if (pathname === "/v1/realtime/calls") return method === "POST" ? "call" : null;
  return pathname.startsWith("/v1/realtime/") ? "unsupported" : null;
}

export function liveModel(model: string): string {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "" || lower === "gpt-realtime" || lower.startsWith("gpt-realtime-") || lower.includes("realtime-preview")) return LIVE_MODEL;
  return trimmed;
}

export function realtimeError(status: number, message: string, type: string, code: string): Response {
  return Response.json({ error: { message, type, param: null, code } }, { status, headers: { "cache-control": "no-store" } });
}

function protocolHeaders(request: Request, accessToken: string, accountId: string): Headers {
  const headers = new Headers();
  for (const name of PROTOCOL_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${accessToken}`);
  if (accountId !== "") headers.set("chatgpt-account-id", accountId);
  return headers;
}

// The client's model, defaulting as CPA does.
export function socketModel(url: URL): string {
  return url.searchParams.get("model")?.trim() || DEFAULT_SOCKET_MODEL;
}

// The upstream WebSocket handshake. Workers open WebSockets with fetch over https.
export function realtimeSocketRequest(request: Request, model: string, accessToken: string, accountId: string): Request {
  const headers = protocolHeaders(request, accessToken, accountId);
  headers.delete("openai-alpha");
  if (!headers.has("originator")) headers.set("originator", SOCKET_ORIGINATOR);
  headers.set("upgrade", "websocket");
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "" && !KEY_SUBPROTOCOL.test(protocol));
  if (protocols.length > 0) headers.set("sec-websocket-protocol", protocols.join(", "));
  return new Request(`${REALTIME_UPSTREAM}?${new URLSearchParams({ model })}`, { method: "GET", headers });
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function modelOf(payload: Record<string, unknown>): string {
  const session = objectOf(payload.session);
  if (typeof session?.model === "string" && session.model.trim() !== "") return session.model.trim();
  return typeof payload.model === "string" ? payload.model.trim() : "";
}

// A call offer's body for ChatGPT: a multipart form becomes CPA's JSON shape, and the model,
// wherever it is given, becomes the one ChatGPT logins serve.
export async function callBody(request: Request): Promise<{ body: string; contentType: string; model: string } | string> {
  const contentType = request.headers.get("content-type") ?? "";
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (media === "multipart/form-data") {
    const form = await request.formData().catch(() => null);
    if (form === null) return "The multipart body couldn't be read.";
    const sdp = form.get("sdp");
    if (typeof sdp !== "string") return "The multipart body needs an sdp field.";
    const sessionField = form.get("session");
    let session: Record<string, unknown> | null = null;
    if (sessionField !== null) {
      if (typeof sessionField !== "string") return "The session field must be JSON.";
      try {
        session = objectOf(JSON.parse(sessionField));
      } catch {
        session = null;
      }
      if (session === null) return "The session field must be a JSON object.";
    }
    const payload: Record<string, unknown> = session === null ? { sdp } : { sdp, session };
    return withLiveModel(payload);
  }
  const text = await request.text();
  if (media === "application/json") {
    let payload: Record<string, unknown> | null;
    try {
      payload = objectOf(JSON.parse(text));
    } catch {
      payload = null;
    }
    if (payload === null) return "The request body must be a JSON object.";
    return withLiveModel(payload);
  }
  if (text.trim() === "") return "The call needs an SDP offer.";
  return { body: text, contentType: contentType || "application/sdp", model: LIVE_MODEL };
}

function withLiveModel(payload: Record<string, unknown>): { body: string; contentType: string; model: string } {
  const model = liveModel(modelOf(payload));
  const session = objectOf(payload.session);
  if (session !== null) payload.session = { ...session, model };
  else if ("model" in payload) payload.model = model;
  return { body: JSON.stringify(payload), contentType: "application/json", model };
}

export function realtimeCallRequest(request: Request, body: string, contentType: string, accessToken: string, accountId: string): Request {
  const headers = protocolHeaders(request, accessToken, accountId);
  headers.set("content-type", contentType);
  return new Request(CODEX_CALLS_UPSTREAM, { method: "POST", headers, body });
}

function callId(location: string): string {
  const trimmed = location.trim();
  if (CALL_ID.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, "https://chatgpt.com");
  } catch {
    return "";
  }
  const fromQuery = parsed.searchParams.get("call_id")?.trim() ?? "";
  if (CALL_ID.test(fromQuery)) return fromQuery;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const id = parts.at(-1) ?? "";
  const parent = parts.at(-2) ?? "";
  return CALL_ID.test(id) && (parent === "live" || parent === "calls") ? id : "";
}

// ChatGPT's SDP answer, with only the headers CPA passes on, and the call's address on this gateway.
export async function callResponse(upstream: Response): Promise<Response> {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of CALL_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const id = upstream.ok ? callId(upstream.headers.get("location") ?? "") : "";
  if (id !== "") headers.set("location", `/v1/realtime/calls/${id}`);
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}
