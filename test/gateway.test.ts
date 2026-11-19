import { describe, expect, it } from "vitest";
import { handle, type Forward, type GatewayConfig, type LoginLimiter } from "../src/gateway.ts";
import { KeyGuard } from "../src/key-guard.ts";
import { classify } from "../src/routes.ts";
import { SESSION_COOKIE, issueSession, passwordMatches, readCookie, sessionIsValid } from "../worker/src/session.ts";

const PASSWORD = "correct-horse-battery-staple-0123456789";
const NOW = 1_800_000_000;
const CLIENT_KEY = "client-key-0123456789abcdef0123456789abcdef";
const MANAGEMENT_KEY = "management-key-0123456789abcdef0123456789";

const unlimited: LoginLimiter = { limit: async () => ({ success: true }) };

function freshConfig(nowSeconds: () => number = () => NOW): GatewayConfig {
  return { dashboardPassword: PASSWORD, managementKey: MANAGEMENT_KEY, nowSeconds, keyGuard: new KeyGuard(nowSeconds), loginLimiter: unlimited };
}

const config = freshConfig();

function presentedKey(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.replace(/^bearer\s+/i, "").trim() || request.headers.get("x-api-key") || new URL(request.url).searchParams.get("key");
}

function fakeCpa(keys: string[]): { forward: Forward; seen: Request[]; probes: Request[] } {
  const seen: Request[] = [];
  const probes: Request[] = [];
  return {
    seen,
    probes,
    forward: async (request) => {
      const key = presentedKey(request);
      if (key?.startsWith("probe-")) probes.push(request);
      else seen.push(request);
      if (keys.length > 0 && (key === null || !keys.includes(key))) return Response.json({ error: "Invalid API key" }, { status: 401 });
      return new Response("from cpa", { status: 200 });
    },
  };
}

function recorder(): { forward: Forward; seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    forward: async (request) => {
      seen.push(request);
      return new Response("from cpa", { status: 200 });
    },
  };
}

function at(path: string, init: RequestInit = {}): Request {
  return new Request(`https://gateway.example${path}`, init);
}

async function sessionCookie(): Promise<string> {
  return `${SESSION_COOKIE}=${await issueSession(PASSWORD, NOW)}`;
}

describe("classify", () => {
  it.each([
    ["/v1/messages", "api"],
    ["/v1/messages/count_tokens", "api"],
    ["/v1/chat/completions", "api"],
    ["/v1beta/models", "api"],
    ["/healthz", "health"],
    ["/management.html", "dashboard"],
    ["/v0/management/config", "dashboard"],
    ["/v8/management/oauth/auth-url", "dashboard"],
    ["/", "home"],
    ["/login", "login"],
    ["/logout", "logout"],
    ["/anthropic/callback", "blocked"],
    ["/codex/callback", "blocked"],
    ["/callback", "oauth-callback"],
    ["/auth/callback", "oauth-callback"],
    ["/oauth-callback", "oauth-callback"],
    ["/v1", "blocked"],
    ["/v0/management", "blocked"],
    ["/v1/%2e%2e/v0/management/config", "blocked"],
    ["/v1/..%2Fv0/management/config", "blocked"],
    ["/v1//messages", "blocked"],
  ])("%s is %s", (path, route) => {
    expect(classify(path)).toBe(route);
  });

  it("sees the path after URL normalisation", () => {
    expect(classify(new URL("https://gateway.example/v1/../v0/management/config").pathname)).toBe("dashboard");
  });
});

describe("session", () => {
  it("accepts its own token until it expires", async () => {
    const token = await issueSession(PASSWORD, NOW);
    expect(await sessionIsValid(PASSWORD, token, NOW + 60)).toBe(true);
    expect(await sessionIsValid(PASSWORD, token, NOW + 12 * 60 * 60)).toBe(false);
  });

  it("rejects tokens signed with another password or edited", async () => {
    const token = await issueSession(PASSWORD, NOW);
    expect(await sessionIsValid("another-password", token, NOW)).toBe(false);
    const [, signature] = token.split(".");
    expect(await sessionIsValid(PASSWORD, `${NOW + 999_999}.${signature}`, NOW)).toBe(false);
    expect(await sessionIsValid(PASSWORD, "garbage", NOW)).toBe(false);
    expect(await sessionIsValid(PASSWORD, `${token}.extra`, NOW)).toBe(false);
  });

  it("compares passwords exactly and never matches an empty secret", async () => {
    expect(await passwordMatches(PASSWORD, PASSWORD)).toBe(true);
    expect(await passwordMatches(`${PASSWORD}x`, PASSWORD)).toBe(false);
    expect(await passwordMatches("", "")).toBe(false);
  });

  it("reads one cookie out of a header", () => {
    expect(readCookie("a=1; b=two=2; c=3", "b")).toBe("two=2");
    expect(readCookie("a=1", "b")).toBeNull();
    expect(readCookie(null, "b")).toBeNull();
  });
});

describe("handle", () => {
  it("forwards API calls to CPA without the browser's cookies once CPA requires a key", async () => {
    const { forward, seen, probes } = fakeCpa([CLIENT_KEY]);
    const response = await handle(
      at("/v1/messages", { method: "POST", headers: { "x-api-key": CLIENT_KEY, cookie: await sessionCookie() }, body: "{}" }),
      freshConfig(),
      forward,
    );
    expect(response.status).toBe(200);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.url).toBe("https://gateway.example/v1/models");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("x-api-key")).toBe(CLIENT_KEY);
    expect(seen[0]?.headers.get("cookie")).toBeNull();
    expect(await seen[0]?.text()).toBe("{}");
  });

  it("leaves checking the key to CPA", async () => {
    const { forward, seen } = fakeCpa([CLIENT_KEY]);
    const guarded = freshConfig();
    expect((await handle(at("/v1/models", { headers: { "x-api-key": "guess" } }), guarded, forward)).status).toBe(401);
    expect((await handle(at("/v1/models"), guarded, forward)).status).toBe(401);
    expect((await handle(at(`/v1beta/models?key=${CLIENT_KEY}`), guarded, forward)).status).toBe(200);
    expect(seen).toHaveLength(3);
  });

  it("refuses every API call while CPA has no keys, which CPA alone would let through", async () => {
    const { forward, seen, probes } = fakeCpa([]);
    const response = await handle(at("/v1/models", { headers: { "x-api-key": "anything" } }), freshConfig(), forward);
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).toContain("API Keys in the dashboard");
    expect(probes).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it("asks CPA again for every call while it has no keys, so the first key works at once", async () => {
    const keys: string[] = [];
    const { forward, seen } = fakeCpa(keys);
    const guarded = freshConfig();
    expect((await handle(at("/v1/models", { headers: { "x-api-key": CLIENT_KEY } }), guarded, forward)).status).toBe(401);
    keys.push(CLIENT_KEY);
    expect((await handle(at("/v1/models", { headers: { "x-api-key": CLIENT_KEY } }), guarded, forward)).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("rechecks CPA after a short while and after any dashboard change", async () => {
    const keys = [CLIENT_KEY];
    const { forward, probes } = fakeCpa(keys);
    let now = NOW;
    const guarded = freshConfig(() => now);
    const call = () => handle(at("/v1/models", { headers: { "x-api-key": CLIENT_KEY } }), guarded, forward);
    await call();
    await call();
    expect(probes).toHaveLength(1);
    now += 15;
    await call();
    expect(probes).toHaveLength(2);
    keys.length = 0;
    const save = at("/v8/management/config/access/api-keys", { method: "PUT", headers: { cookie: await sessionCookie(), authorization: "Bearer sub2api-session" }, body: "[]" });
    expect((await handle(save, guarded, forward)).status).toBe(200);
    expect((await call()).status).toBe(401);
    expect(probes).toHaveLength(3);
  });

  it("trusts no cached answer for a while after a dashboard change, in case CPA applies it late", async () => {
    const keys = [CLIENT_KEY];
    const { forward, probes } = fakeCpa(keys);
    let now = NOW;
    const guarded = freshConfig(() => now);
    const call = () => handle(at("/v1/models", { headers: { "x-api-key": CLIENT_KEY } }), guarded, forward);
    const save = at("/v8/management/config/access/api-keys", { method: "PUT", headers: { cookie: await sessionCookie(), authorization: "Bearer sub2api-session" }, body: "[]" });
    await handle(save, guarded, forward);
    expect((await call()).status).toBe(200);
    keys.length = 0;
    expect((await call()).status).toBe(401);
    expect(probes).toHaveLength(2);
    keys.push(CLIENT_KEY);
    now += 15;
    await call();
    await call();
    expect(probes).toHaveLength(3);
  });

  it("fails closed when CPA cannot be asked", async () => {
    const down: Forward = async () => new Response("starting", { status: 502 });
    const response = await handle(at("/v1/models", { headers: { "x-api-key": CLIENT_KEY } }), freshConfig(), down);
    expect(response.status).toBe(503);
    const thrown: Forward = async () => {
      throw new Error("container not running");
    };
    expect((await handle(at("/v1/models"), freshConfig(), thrown)).status).toBe(503);
  });

  it("forwards the health check without a key", async () => {
    const { forward, seen } = recorder();
    expect((await handle(at("/healthz"), config, forward)).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("hands a provider's callback to CPA for a signed-in user", async () => {
    const { forward, seen } = recorder();
    const response = await handle(
      at("/callback?code=abc&state=f1d66a216e61aab0375b6857db64a6a5", { headers: { cookie: await sessionCookie() } }),
      config,
      forward,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Login received");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://gateway.example/v0/management/oauth-callback?code=abc&state=f1d66a216e61aab0375b6857db64a6a5");
    expect(seen[0]?.headers.get("cookie")).toBeNull();
  });

  it("keeps the callback closed without a session", async () => {
    const { forward, seen } = recorder();
    const response = await handle(at("/auth/callback?code=abc&state=xyz"), config, forward);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Sign in");
    expect(seen).toHaveLength(0);
  });

  it("explains a callback CPA refuses", async () => {
    const refused: Forward = async () => Response.json({ status: "error", error: "unknown or expired state" }, { status: 404 });
    const response = await handle(at("/oauth-callback?code=abc&state=xyz", { headers: { cookie: await sessionCookie() } }), config, refused);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain("unknown or expired state");
    expect(text).toContain("Start the login again");
  });

  it("never forwards blocked paths", async () => {
    const { forward, seen } = recorder();
    for (const path of ["/anthropic/callback?code=x", "/codex/callback", "/devin/callback", "/robots.txt", "/v1"]) {
      expect((await handle(at(path), config, forward)).status).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("keeps the dashboard closed without a session", async () => {
    const { forward, seen } = recorder();
    const page = await handle(at("/management.html"), config, forward);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login");
    const api = await handle(at("/v8/management/config", { headers: { authorization: "Bearer guess" } }), config, forward);
    expect(api.status).toBe(401);
    const forged = await handle(at("/v0/management/config", { headers: { cookie: `${SESSION_COOKIE}=1.abc` } }), config, forward);
    expect(forged.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("sends CPA the management key itself for a signed-in user", async () => {
    const { forward, seen } = recorder();
    const headers = { cookie: await sessionCookie(), authorization: "Bearer sub2api-session", "x-management-key": "typed-by-hand" };
    const response = await handle(at("/v8/management/config", { headers }), config, forward);
    expect(response.status).toBe(200);
    expect(seen[0]?.headers.get("cookie")).toBeNull();
    expect(seen[0]?.headers.get("x-management-key")).toBeNull();
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${MANAGEMENT_KEY}`);
  });

  it("needs the dashboard's key header, which a cross-site form cannot send", async () => {
    const { forward, seen } = recorder();
    const response = await handle(at("/v8/management/config", { method: "PUT", headers: { cookie: await sessionCookie() }, body: "{}" }), config, forward);
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("serves the dashboard with the sign-in script and without the session cookie", async () => {
    const seen: Request[] = [];
    const page: Forward = async (request) => {
      seen.push(request);
      return new Response("<!doctype html><html><head><title>CPA</title></head><body></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8", "content-length": "70", etag: "x" },
      });
    };
    const headers = { cookie: await sessionCookie(), "accept-encoding": "gzip, zstd", range: "bytes=0-10", "if-none-match": "x" };
    const response = await handle(at("/management.html", { headers }), config, page);
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html><html><head><script>\(\(\) => \{/);
    expect(html).toContain('"sub2api-session"');
    expect(html).toContain('id = "sub2api-providers-back"');
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain(MANAGEMENT_KEY);
    expect(html).not.toContain(PASSWORD);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    for (const name of ["cookie", "accept-encoding", "range", "if-none-match"]) expect(seen[0]?.headers.get(name)).toBeNull();
    const post = await handle(at("/management.html", { method: "POST", headers: { cookie: await sessionCookie() } }), config, page);
    expect(post.status).toBe(404);
  });

  it("restarts CPA once when it rejects the key, as after a changed secret", async () => {
    const rejected: Forward = async () => Response.json({ error: "invalid management key" }, { status: 401 });
    let restarts = 0;
    const restarting = { ...config, keyRejected: async () => restarts++ === 0 };
    const call = async () => handle(at("/v8/management/config", { headers: { cookie: await sessionCookie(), authorization: "Bearer sub2api-session" } }), restarting, rejected);
    const first = await call();
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("30");
    expect((await call()).status).toBe(401);
    expect(restarts).toBe(2);
  });

  it("does not restart CPA for a 401 a provider sent back", async () => {
    const provider: Forward = async () => Response.json({ error: "upstream said unauthorized" }, { status: 401 });
    let restarts = 0;
    const watching = { ...config, keyRejected: async () => ++restarts > 0 };
    const response = await handle(at("/v0/management/api-call", { method: "POST", headers: { cookie: await sessionCookie(), authorization: "Bearer x" }, body: "{}" }), watching, provider);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "upstream said unauthorized" });
    expect(restarts).toBe(0);
  });

  it("passes a compressed dashboard through unchanged", async () => {
    const gzipped: Forward = async () => new Response("binary", { headers: { "content-type": "text/html", "content-encoding": "gzip" } });
    const response = await handle(at("/management.html", { headers: { cookie: await sessionCookie() } }), config, gzipped);
    expect(await response.text()).toBe("binary");
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  it("signs in with the right password and sets a strict cookie", async () => {
    const { forward } = recorder();
    const response = await handle(
      at("/login", { method: "POST", body: new URLSearchParams({ password: PASSWORD }) }),
      config,
      forward,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/management.html");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=\\d+\\.[A-Za-z0-9_-]+; `));
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const token = readCookie(cookie.split(";")[0] ?? "", SESSION_COOKIE) ?? "";
    expect(await sessionIsValid(PASSWORD, token, NOW)).toBe(true);
  });

  it("refuses a wrong password", async () => {
    const { forward } = recorder();
    const response = await handle(at("/login", { method: "POST", body: new URLSearchParams({ password: "nope" }) }), config, forward);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("Wrong password.");
  });

  it("limits sign-in attempts per client address", async () => {
    const { forward } = recorder();
    const seen: string[] = [];
    const limited = { ...config, loginLimiter: { limit: async ({ key }: { key: string }) => ({ success: seen.push(key) <= 1 }) } };
    const attempt = () =>
      handle(at("/login", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" }, body: new URLSearchParams({ password: PASSWORD }) }), limited, forward);
    expect((await attempt()).status).toBe(303);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect(await blocked.text()).toContain("Too many sign-in attempts");
    expect(seen).toEqual(["203.0.113.7", "203.0.113.7"]);
  });

  it("accepts any non-empty password the user picks", async () => {
    const { forward } = recorder();
    const simple = { ...config, dashboardPassword: "123456" };
    const response = await handle(at("/login", { method: "POST", body: new URLSearchParams({ password: "123456" }) }), simple, forward);
    expect(response.status).toBe(303);
  });

  it("turns sign-in off while the dashboard password is missing", async () => {
    const { forward } = recorder();
    const weak = { ...config, dashboardPassword: "" };
    const form = await handle(at("/login"), weak, forward);
    expect(await form.text()).toContain("Sign-in is off");
    const attempt = await handle(at("/login", { method: "POST", body: new URLSearchParams({ password: "" }) }), weak, forward);
    expect(attempt.status).toBe(503);
    expect(attempt.headers.get("set-cookie")).toBeNull();
    const forgedWithKnownPassword = `${SESSION_COOKIE}=${await issueSession("", NOW)}`;
    const dashboard = await handle(at("/v8/management/config", { headers: { cookie: forgedWithKnownPassword } }), weak, forward);
    expect(dashboard.status).toBe(401);
  });

  it("sends the home page to login or the dashboard", async () => {
    const { forward } = recorder();
    expect((await handle(at("/"), config, forward)).headers.get("location")).toBe("/login");
    const signed = await handle(at("/", { headers: { cookie: await sessionCookie() } }), config, forward);
    expect(signed.headers.get("location")).toBe("/management.html");
  });

  it("serves the login form and clears the cookie on logout", async () => {
    const { forward } = recorder();
    const form = await handle(at("/login"), config, forward);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('name="password"');
    const out = await handle(at("/logout"), config, forward);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
