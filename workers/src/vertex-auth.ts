import { OAuthError, type Fetcher } from "./claude-oauth.ts";

// Vertex AI with a Google Cloud service account, as in CPA: the account's key signs a JWT, which
// Google's token endpoint trades for an hour-long access token. Nothing is sent but to Google.
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_LOCATION = "us-central1";

export interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string;
  readonly projectId: string;
}

export interface VertexLogin {
  readonly account: ServiceAccount;
  readonly projectId: string;
  readonly location: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isTree(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A service account key file's fields, or null when it can't sign.
export function serviceAccountOf(value: unknown): ServiceAccount | null {
  if (!isTree(value)) return null;
  const clientEmail = text(value.client_email);
  const privateKey = typeof value.private_key === "string" ? value.private_key : "";
  if (clientEmail === "" || !privateKey.includes("PRIVATE KEY")) return null;
  return { clientEmail, privateKey, privateKeyId: text(value.private_key_id), projectId: text(value.project_id) };
}

// Vertex locations are Google region names; anything else would steer requests to another host.
export function validLocation(location: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(location);
}

// The auth file CPA writes for an imported service account, so files move between installs.
export function vertexFileData(serviceAccount: Record<string, unknown>, location: string): Record<string, unknown> {
  const account = serviceAccountOf(serviceAccount);
  const projectId = account?.projectId ?? "";
  const email = account?.clientEmail ?? "";
  return { service_account: serviceAccount, project_id: projectId, email, location: location || DEFAULT_LOCATION, type: "vertex", label: email !== "" ? `${projectId} (${email})` : projectId };
}

// CPA's file name: vertex-<project id with path characters replaced>.json.
export function vertexFileName(projectId: string): string {
  const part = projectId.trim().replaceAll(/[/\\:]/g, "_").replaceAll(" ", "-");
  return `vertex-${part.replace(/[^A-Za-z0-9._@+-]/g, "") || "vertex"}.json`;
}

export function vertexLogin(data: Record<string, unknown>): VertexLogin | null {
  const account = serviceAccountOf(data.service_account);
  if (account === null) return null;
  const projectId = text(data.project_id) || text(data.project) || account.projectId;
  const location = text(data.location) || "global";
  if (projectId === "" || !validLocation(location)) return null;
  const expires = Date.parse(text(data.expired));
  return { account, projectId, location, accessToken: text(data.access_token), expiresAt: Number.isFinite(expires) ? Math.floor(expires / 1000) : 0 };
}

// The Vertex host for a location, as CPA picks it.
export function vertexHost(location: string): string {
  if (location === "" || location === "global") return "https://aiplatform.googleapis.com";
  if (location === "us" || location === "eu") return `https://aiplatform.${location}.rep.googleapis.com`;
  return `https://${location}-aiplatform.googleapis.com`;
}

// The models collection a login's requests go to; a model and action are appended per request.
export function vertexModelsUrl(login: { projectId: string; location: string }): string {
  return `${vertexHost(login.location)}/v1/projects/${encodeURIComponent(login.projectId)}/locations/${login.location}/publishers/google/models`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// rsaEncryption's AlgorithmIdentifier, for wrapping a PKCS #1 key as PKCS #8.
const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

// Google issues PKCS #8 keys, but CPA rewrites them as PKCS #1, which Web Crypto can't import.
export function pkcs8Of(pem: string): Uint8Array {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END \1?PRIVATE KEY-----/.exec(pem.replaceAll("\\n", "\n"));
  if (match === null) throw new OAuthError("The service account's private_key isn't a PEM key", 400);
  const der = Uint8Array.from(atob((match[2] ?? "").replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  if (match[1] === undefined) return der;
  const octets = [0x04, ...derLength(der.length), ...der];
  const body = [0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...octets];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

// The return type is inferred: CryptoKey isn't a global name under Node's types, which tests use.
export async function signingKey(account: ServiceAccount) {
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8Of(account.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("The service account's private_key can't be read", 400);
  }
}

async function signedAssertion(account: ServiceAccount, nowSeconds: number): Promise<string> {
  const key = await signingKey(account);
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const header = account.privateKeyId === "" ? { alg: "RS256", typ: "JWT" } : { alg: "RS256", typ: "JWT", kid: account.privateKeyId };
  const claims = { iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 };
  const unsigned = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

// The token endpoint is always Google's own: a token_uri in an uploaded file is ignored, so a
// crafted file can't send the signed assertion elsewhere.
export async function mintToken(fetcher: Fetcher, account: ServiceAccount, nowSeconds: number): Promise<{ accessToken: string; expiresAt: number }> {
  const assertion = await signedAssertion(account, nowSeconds);
  const response = await fetcher(
    new Request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    }),
  );
  const body = await response.text();
  if (!response.ok) throw new OAuthError(`Google answered ${response.status}: ${body.slice(0, 300)}`, response.status);
  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new OAuthError("Google sent a token response that isn't JSON", 502);
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") throw new OAuthError("Google's token response has no access token", 502);
  return { accessToken: parsed.access_token, expiresAt: nowSeconds + (typeof parsed.expires_in === "number" ? parsed.expires_in : 3600) };
}
