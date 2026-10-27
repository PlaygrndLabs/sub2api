export const SESSION_COOKIE = "__Host-gateway_session";
export const SESSION_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();

async function sessionKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`sub2api session v1\0${password}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function issueSession(password: string, nowSeconds: number): Promise<string> {
  const expires = String(nowSeconds + SESSION_SECONDS);
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(password), encoder.encode(expires));
  return `${expires}.${toBase64Url(signature)}`;
}

export async function sessionIsValid(password: string, token: string, nowSeconds: number): Promise<boolean> {
  const [expires, signature, extra] = token.split(".");
  if (expires === undefined || signature === undefined || extra !== undefined || !/^\d{1,12}$/.test(expires)) return false;
  if (Number(expires) <= nowSeconds) return false;
  const bytes = fromBase64Url(signature);
  if (bytes === null) return false;
  return crypto.subtle.verify("HMAC", await sessionKey(password), bytes, encoder.encode(expires));
}

export async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([given, expected].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))));
  const left = new Uint8Array(a ?? new ArrayBuffer(0));
  const right = new Uint8Array(b ?? new ArrayBuffer(0));
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0 && expected.length > 0;
}

export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
