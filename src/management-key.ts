// CPA needs a management key, but nobody types it: the gateway sends it for a signed-in session.
// A MANAGEMENT_KEY secret wins when set (installs made before it became optional). Otherwise the
// key is derived from DASHBOARD_PASSWORD, so a deploy needs one secret. Changing the password then
// changes the key too, and the container restarts to pick it up (see Cpa.keyRejected).
const encoder = new TextEncoder();
const MIN_PASSWORD_LENGTH = 1;

export async function managementKeyFor(secret: string | undefined, dashboardPassword: string | undefined): Promise<string> {
  const given = secret?.trim() ?? "";
  if (given !== "") return given;
  const password = dashboardPassword ?? "";
  if (password.length < MIN_PASSWORD_LENGTH) return "";
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode("sub2api management key v1"));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
