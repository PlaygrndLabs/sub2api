export const UPSTREAM = "https://api.anthropic.com";
export const OAUTH_BETA = "oauth-2025-04-20";

// The Anthropic endpoints a subscription token can serve, with the method each takes.
const ROUTES = new Map([
  ["/v1/messages", "POST"],
  ["/v1/messages/count_tokens", "POST"],
  ["/v1/models", "GET"],
]);

const FORWARDED_HEADERS = new Set(["accept", "content-type", "anthropic-version", "user-agent", "x-app"]);
const FORWARDED_PREFIXES = ["x-stainless-", "x-claude-code-"];
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "connection", "keep-alive", "transfer-encoding"]);

export function isProxied(pathname: string): boolean {
  return ROUTES.has(pathname);
}

export function methodAllowed(pathname: string, method: string): boolean {
  return ROUTES.get(pathname) === method;
}

export function presentedKey(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim();
  return bearer || request.headers.get("x-api-key")?.trim() || null;
}

// The request body is a stream handed straight to Anthropic: it is never read or parsed here,
// which keeps CPU time flat however large the conversation is.
export function upstreamRequest(request: Request, url: URL, accessToken: string): Request {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARDED_HEADERS.has(name) || FORWARDED_PREFIXES.some((prefix) => name.startsWith(prefix))) headers.set(name, value);
  }
  const betas = (request.headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter((beta) => beta !== "");
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  headers.set("anthropic-beta", betas.join(","));
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  headers.set("authorization", `Bearer ${accessToken}`);
  const target = `${UPSTREAM}${url.pathname}${url.search}`;
  return new Request(new Request(target, request), { headers });
}

export function downstreamResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) if (!DROPPED_RESPONSE_HEADERS.has(name)) headers.set(name, value);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}
