// Claude subscription OAuth (authorization code + PKCE), the same flow Claude Code and CPA use.
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const REDIRECT_URI = "http://localhost:54545/callback";
export const SCOPE = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export interface Credential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly email: string;
}

export type Fetcher = (request: Request) => Promise<Response>;

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export async function authorizeUrl(state: string, verifier: string): Promise<string> {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// Accepts what the person pastes: the whole localhost callback address, or the "code#state"
// text Anthropic's page shows.
export function parseCallback(text: string): { code: string; state: string } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    return code && state ? { code: code.split("#")[0] ?? code, state } : null;
  }
  const [code, state] = trimmed.split("#");
  return code && state ? { code, state } : null;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: { email_address?: unknown };
}

async function tokenRequest(fetcher: Fetcher, body: Record<string, string>, nowSeconds: number, fallback: Partial<Credential>): Promise<Credential> {
  const response = await fetcher(
    new Request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  if (!response.ok) throw new OAuthError(`Anthropic answered ${response.status}: ${text.slice(0, 300)}`, response.status);
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new OAuthError("Anthropic sent a token response that isn't JSON", 502);
  }
  const accessToken = parsed.access_token;
  const refreshToken = typeof parsed.refresh_token === "string" && parsed.refresh_token !== "" ? parsed.refresh_token : fallback.refreshToken;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  if (typeof accessToken !== "string" || accessToken === "" || refreshToken === undefined) {
    throw new OAuthError("Anthropic's token response has no tokens", 502);
  }
  const email = typeof parsed.account?.email_address === "string" ? parsed.account.email_address : (fallback.email ?? "");
  return { accessToken, refreshToken, expiresAt: nowSeconds + expiresIn, email };
}

export function exchangeCode(fetcher: Fetcher, code: string, state: string, verifier: string, nowSeconds: number): Promise<Credential> {
  return tokenRequest(
    fetcher,
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier, state },
    nowSeconds,
    {},
  );
}

export function refresh(fetcher: Fetcher, current: Credential, nowSeconds: number): Promise<Credential> {
  return tokenRequest(
    fetcher,
    { grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: CLIENT_ID, scope: SCOPE },
    nowSeconds,
    current,
  );
}
