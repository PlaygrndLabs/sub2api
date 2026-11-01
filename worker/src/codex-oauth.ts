import { codeChallenge, OAuthError, type Fetcher } from "./claude-oauth.ts";

// ChatGPT (Codex) subscription OAuth (authorization code + PKCE), the same flow the Codex CLI
// and CPA use. The ID token names the ChatGPT account, which every Codex request must carry.
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid email profile offline_access";
const REFRESH_SCOPE = "openid profile email";
const DEFAULT_PLAN = "free";

export interface CodexCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly accountId: string;
  readonly email: string;
  readonly planType: string;
  readonly expiresAt: number;
}

export async function authorizeUrl(state: string, verifier: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// The ID token's claims, read without checking its signature: it came straight from OpenAI's
// token endpoint over TLS, and is only used to label the login and address the account.
export function idTokenClaims(idToken: string): { accountId: string; email: string; planType: string } {
  const empty = { accountId: "", email: "", planType: DEFAULT_PLAN };
  const payload = idToken.split(".")[1];
  if (payload === undefined) return empty;
  let claims: Record<string, unknown>;
  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const decoded: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))));
    if (typeof decoded !== "object" || decoded === null) return empty;
    claims = decoded as Record<string, unknown>;
  } catch {
    return empty;
  }
  const auth = (typeof claims["https://api.openai.com/auth"] === "object" && claims["https://api.openai.com/auth"] !== null ? claims["https://api.openai.com/auth"] : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return { accountId: text(auth.chatgpt_account_id), email: text(claims.email), planType: text(auth.chatgpt_plan_type) || DEFAULT_PLAN };
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
}

async function tokenRequest(fetcher: Fetcher, body: Record<string, string>, nowSeconds: number, fallback: Partial<CodexCredential>): Promise<CodexCredential> {
  const response = await fetcher(
    new Request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
    }),
  );
  const text = await response.text();
  if (!response.ok) throw new OAuthError(`OpenAI answered ${response.status}: ${text.slice(0, 300)}`, response.status);
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new OAuthError("OpenAI sent a token response that isn't JSON", 502);
  }
  const nonEmpty = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  const accessToken = nonEmpty(parsed.access_token);
  const refreshToken = nonEmpty(parsed.refresh_token) ?? fallback.refreshToken;
  if (accessToken === undefined || refreshToken === undefined) throw new OAuthError("OpenAI's token response has no tokens", 502);
  const idToken = nonEmpty(parsed.id_token) ?? fallback.idToken ?? "";
  const claims = idTokenClaims(idToken);
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: claims.accountId || (fallback.accountId ?? ""),
    email: claims.email || (fallback.email ?? ""),
    planType: claims.planType,
    expiresAt: nowSeconds + expiresIn,
  };
}

export function exchangeCode(fetcher: Fetcher, code: string, verifier: string, nowSeconds: number): Promise<CodexCredential> {
  return tokenRequest(fetcher, { grant_type: "authorization_code", client_id: CLIENT_ID, code, redirect_uri: REDIRECT_URI, code_verifier: verifier }, nowSeconds, {});
}

export function refresh(fetcher: Fetcher, current: CodexCredential, nowSeconds: number): Promise<CodexCredential> {
  return tokenRequest(fetcher, { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: current.refreshToken, scope: REFRESH_SCOPE }, nowSeconds, current);
}

// CPA's codex auth file fields, so files move between installs unchanged.
export function codexFileData(credential: CodexCredential): Record<string, unknown> {
  return {
    type: "codex",
    id_token: credential.idToken,
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    account_id: credential.accountId,
    email: credential.email,
    plan_type: credential.planType,
    expired: new Date(credential.expiresAt * 1000).toISOString(),
    last_refresh: new Date().toISOString(),
  };
}

export function codexCredential(data: Record<string, unknown>): CodexCredential | null {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const accessToken = text(data.access_token);
  const refreshToken = text(data.refresh_token);
  if (accessToken === "" || refreshToken === "") return null;
  const idToken = text(data.id_token);
  const expires = Date.parse(text(data.expired));
  return {
    accessToken,
    refreshToken,
    idToken,
    // Files from older CPA releases may lack account_id; the ID token still has it.
    accountId: text(data.account_id) || idTokenClaims(idToken).accountId,
    email: text(data.email),
    planType: text(data.plan_type) || DEFAULT_PLAN,
    expiresAt: Number.isFinite(expires) ? Math.floor(expires / 1000) : 0,
  };
}

// CPA's file name: codex-<first 8 hex of sha256(account id)>-<email>-<plan>.json.
export async function codexFileName(credential: CodexCredential): Promise<string> {
  const plan = credential.planType.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part !== "").join("-");
  const email = credential.email.replace(/[^A-Za-z0-9@._+-]/g, "") || "account";
  const parts = ["codex"];
  if (credential.accountId !== "") {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential.accountId)));
    parts.push(Array.from(digest.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join(""));
  }
  parts.push(email);
  if (plan !== "") parts.push(plan);
  return `${parts.join("-")}.json`;
}
