import { OAuthError, type Fetcher } from "./claude-oauth.ts";

// Kimi Code subscription login (OAuth device flow), as CPA does it. Requests say plainly that they
// come from sub2api, as CPA's say they come from CLIProxyAPI; nothing poses as Kimi's own CLI.
export const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const PLATFORM = "sub2api";
const DEFAULT_EXPIRES_IN = 3600;
// Kimi asks for at least this long between polls; slow_down adds to it.
const MIN_INTERVAL = 5;

export type KimiDomain = "kimi.com" | "kimi.ai";

const HOSTS: Record<KimiDomain, { auth: string; api: string }> = {
  "kimi.com": { auth: "https://auth.kimi.com", api: "https://api.kimi.com/coding" },
  "kimi.ai": { auth: "https://auth.kimi.ai", api: "https://api.kimi.ai/coding" },
};

export function kimiDomain(value: unknown): KimiDomain {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "kimi.ai" || text === "kimi-ai" || text === "ai" ? "kimi.ai" : "kimi.com";
}

export function apiBase(domain: KimiDomain): string {
  return HOSTS[domain].api;
}

// Headers Kimi wants on every call, naming this gateway and the login's own device id.
export function identityHeaders(deviceId: string): Record<string, string> {
  return {
    "user-agent": PLATFORM,
    "x-msh-platform": PLATFORM,
    "x-msh-version": "1",
    "x-msh-device-name": PLATFORM,
    "x-msh-device-model": "Cloudflare Workers",
    "x-msh-device-id": deviceId,
  };
}

export interface KimiToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: string;
  readonly scope: string;
  readonly expiresAt: number;
}

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly url: string;
  readonly interval: number;
  readonly expiresIn: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function form(fetcher: Fetcher, url: string, deviceId: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null; raw: string }> {
  const response = await fetcher(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...identityHeaders(deviceId) },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }).toString(),
    }),
  );
  const raw = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: response.status, body, raw };
}

function tokenOf(body: Record<string, unknown>, nowSeconds: number, fallbackRefresh = ""): KimiToken {
  const accessToken = text(body.access_token);
  if (accessToken === "") throw new OAuthError("Kimi's token response has no access token", 502);
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? Math.floor(body.expires_in) : DEFAULT_EXPIRES_IN;
  return { accessToken, refreshToken: text(body.refresh_token) || fallbackRefresh, tokenType: text(body.token_type) || "Bearer", scope: text(body.scope), expiresAt: nowSeconds + expiresIn };
}

export async function startDevice(fetcher: Fetcher, domain: KimiDomain, deviceId: string): Promise<DeviceCode> {
  const { status, body, raw } = await form(fetcher, `${HOSTS[domain].auth}/api/oauth/device_authorization`, deviceId, {});
  if (status !== 200 || body === null) throw new OAuthError(`Kimi answered ${status}: ${raw.slice(0, 300)}`, status === 200 ? 502 : status);
  const deviceCode = text(body.device_code);
  const url = text(body.verification_uri_complete) || text(body.verification_uri);
  // The dashboard opens this address, so it must be Kimi's own.
  if (deviceCode === "" || !url.startsWith("https://")) throw new OAuthError("Kimi's device code response is incomplete", 502);
  const number = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? Math.floor(value) : fallback);
  return { deviceCode, userCode: text(body.user_code), url, interval: Math.max(MIN_INTERVAL, number(body.interval, MIN_INTERVAL)), expiresIn: number(body.expires_in, 900) };
}

export type PollResult = { status: "wait"; interval?: number } | { status: "ok"; token: KimiToken } | { status: "error"; message: string };

// One look at whether the user has approved the device yet. Kimi answers 200 while waiting too.
export async function pollDevice(fetcher: Fetcher, domain: KimiDomain, deviceId: string, deviceCode: string, interval: number, nowSeconds: number): Promise<PollResult> {
  const { status, body } = await form(fetcher, `${HOSTS[domain].auth}/api/oauth/token`, deviceId, { device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  if (body === null) return { status: "error", message: `Kimi answered ${status}` };
  const error = text(body.error);
  if (error === "authorization_pending") return { status: "wait" };
  if (error === "slow_down") return { status: "wait", interval: interval + 5 };
  if (error === "expired_token") return { status: "error", message: "Authentication failed: the Kimi code expired" };
  if (error === "access_denied") return { status: "error", message: "Authentication failed: access denied" };
  if (error !== "") return { status: "error", message: `Authentication failed: ${error}` };
  try {
    return { status: "ok", token: tokenOf(body, nowSeconds) };
  } catch (failure) {
    return { status: "error", message: failure instanceof OAuthError ? failure.message : "Authentication failed" };
  }
}

export async function refresh(fetcher: Fetcher, domain: KimiDomain, deviceId: string, refreshToken: string, nowSeconds: number): Promise<KimiToken> {
  const { status, body, raw } = await form(fetcher, `${HOSTS[domain].auth}/api/oauth/token`, deviceId, { grant_type: "refresh_token", refresh_token: refreshToken });
  // Kimi refuses a spent refresh token with 401 or 403; either way the user signs in again.
  if (status === 401 || status === 403) throw new OAuthError(`Kimi refused the refresh token (${status})`, 401);
  if (status !== 200 || body === null) throw new OAuthError(`Kimi answered ${status}: ${raw.slice(0, 300)}`, status === 200 ? 502 : status);
  return tokenOf(body, nowSeconds, refreshToken);
}

// CPA's kimi auth file fields, so files move between installs unchanged.
export function kimiFileData(token: KimiToken, domain: KimiDomain, deviceId: string): Record<string, unknown> {
  return {
    type: domain === "kimi.ai" ? "kimi-ai" : "kimi",
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    token_type: token.tokenType,
    scope: token.scope,
    device_id: deviceId,
    domain,
    base_url: apiBase(domain),
    expired: new Date(token.expiresAt * 1000).toISOString(),
    timestamp: Date.now(),
  };
}

export interface KimiLogin {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly domain: KimiDomain;
  readonly deviceId: string;
}

// The API host comes from the domain, never from the file's base_url, so an uploaded file can't
// send the token anywhere but Kimi.
export function kimiLogin(data: Record<string, unknown>): KimiLogin | null {
  const accessToken = text(data.access_token);
  const refreshToken = text(data.refresh_token);
  if (accessToken === "" && refreshToken === "") return null;
  const domain = kimiDomain(text(data.domain) || (text(data.type) === "kimi-ai" ? "kimi.ai" : ""));
  const expires = Date.parse(text(data.expired));
  return { accessToken, refreshToken, expiresAt: Number.isFinite(expires) ? Math.floor(expires / 1000) : 0, domain, deviceId: text(data.device_id) || "sub2api-device" };
}

// The model id Kimi's API takes, as CPA maps it: the "kimi-" catalog prefix is dropped, Claude
// Code's "[1m]" suffix too, and the coding model's aliases become "kimi-for-coding".
export function kimiUpstreamModel(model: string): string {
  const suffix = /\([^()]*\)$/.exec(model.trim())?.[0] ?? "";
  let base = model.trim().slice(0, model.trim().length - suffix.length).toLowerCase();
  if (base.endsWith("[1m]")) base = base.slice(0, -4);
  const coding = ["kimi-k2.8", "k2.8", "kimi-k2.8-code", "k2.8-code", "kimi-k2.8-preview", "k2.8-preview", "kimi-k2.7-code", "k2.7-code", "kimi-for-coding", "for-coding"];
  const fast = ["kimi-k2.7-code-highspeed", "k2.7-code-highspeed", "kimi-for-coding-highspeed", "for-coding-highspeed"];
  let name: string;
  if (coding.includes(base)) name = "kimi-for-coding";
  else if (fast.includes(base)) name = "kimi-for-coding-highspeed";
  else name = base.startsWith("kimi-") ? base.slice(5) : base;
  return `${name}${suffix}`;
}
