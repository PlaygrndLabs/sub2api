import type { KeyGuard } from "./key-guard.ts";
import { classify } from "./routes.ts";
import { SESSION_COOKIE, SESSION_SECONDS, issueSession, passwordMatches, readCookie, sessionIsValid } from "../free/src/session.ts";
import { loginPage, messagePage } from "./login-page.ts";

export type Forward = (request: Request) => Promise<Response>;

export interface LoginLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface GatewayConfig {
  readonly dashboardPassword: string;
  readonly nowSeconds: () => number;
  readonly keyGuard: KeyGuard;
  readonly loginLimiter: LoginLimiter;
}

const MAX_LOGIN_BODY = 4096;
export const MIN_PASSWORD_LENGTH = 16;
const NO_CLIENT_KEYS = "No API key is set up yet: add one under API Keys in the dashboard.";
const CPA_UNAVAILABLE = "The gateway is starting or unavailable. Try again shortly.";
const TOO_MANY_ATTEMPTS = "Too many sign-in attempts. Wait a minute and try again.";
const PASSWORD_NOT_SET = `Sign-in is off: set the DASHBOARD_PASSWORD secret to at least ${MIN_PASSWORD_LENGTH} characters.`;

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  });
}

function withoutCookies(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return new Request(request, { headers });
}

function apiError(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status, headers: { "cache-control": "no-store" } });
}

async function api(request: Request, url: URL, config: GatewayConfig, forward: Forward): Promise<Response> {
  switch (await config.keyGuard.state(url.origin, forward)) {
    case "open":
      return apiError(401, "authentication_error", NO_CLIENT_KEYS);
    case "unavailable":
      return apiError(503, "api_error", CPA_UNAVAILABLE);
    case "required":
      return forward(withoutCookies(request));
  }
}

async function dashboard(request: Request, config: GatewayConfig, forward: Forward): Promise<Response> {
  const writes = request.method !== "GET" && request.method !== "HEAD";
  if (writes) config.keyGuard.forget();
  const response = await forward(withoutCookies(request));
  if (writes) config.keyGuard.forget();
  return response;
}

async function signedIn(request: Request, config: GatewayConfig): Promise<boolean> {
  if (config.dashboardPassword.length < MIN_PASSWORD_LENGTH) return false;
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return token !== null && (await sessionIsValid(config.dashboardPassword, token, config.nowSeconds()));
}

async function oauthCallback(request: Request, url: URL, config: GatewayConfig, forward: Forward): Promise<Response> {
  if (request.method !== "GET") return notFound();
  if (!(await signedIn(request, config))) {
    return html(messagePage("Sign in first", "Sign in to the dashboard, then open this address again.", true), 401);
  }
  const target = new URL(`/v0/management/oauth-callback${url.search}`, url);
  const response = await forward(new Request(target));
  if (response.ok) {
    return html(messagePage("Login received", "CPA is saving this login. Go back to the dashboard to see it.", false));
  }
  const body: unknown = await response.json().catch(() => null);
  const reason = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `CPA answered ${response.status}`;
  return html(messagePage("Login not saved", `${reason}. Start the login again from the dashboard.`, true), response.status);
}

async function login(request: Request, config: GatewayConfig): Promise<Response> {
  if (config.dashboardPassword.length < MIN_PASSWORD_LENGTH) return html(loginPage(PASSWORD_NOT_SET), 503);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_LOGIN_BODY) return html(loginPage("Request too large."), 413);
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await config.loginLimiter.limit({ key: client })).success) return html(loginPage(TOO_MANY_ATTEMPTS), 429);
  const form = await request.formData().catch(() => null);
  const password = form?.get("password");
  if (typeof password !== "string" || !(await passwordMatches(password, config.dashboardPassword))) {
    return html(loginPage("Wrong password."), 401);
  }
  const token = await issueSession(config.dashboardPassword, config.nowSeconds());
  return redirect("/management.html", {
    "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
  });
}

export async function handle(request: Request, config: GatewayConfig, forward: Forward): Promise<Response> {
  const url = new URL(request.url);
  switch (classify(url.pathname)) {
    case "api":
      return api(request, url, config, forward);
    case "health":
      return forward(withoutCookies(request));
    case "oauth-callback":
      return oauthCallback(request, url, config, forward);
    case "home":
      return redirect((await signedIn(request, config)) ? "/management.html" : "/login");
    case "login":
      if (request.method === "POST") return login(request, config);
      if (request.method === "GET") {
        return html(loginPage(config.dashboardPassword.length < MIN_PASSWORD_LENGTH ? PASSWORD_NOT_SET : null));
      }
      return notFound();
    case "logout":
      return redirect("/login", { "set-cookie": `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
    case "dashboard":
      if (await signedIn(request, config)) return dashboard(request, config, forward);
      if (request.method === "GET" && url.pathname === "/management.html") return redirect("/login");
      return Response.json({ error: "sign in at /login first" }, { status: 401 });
    case "blocked":
      return notFound();
  }
}
