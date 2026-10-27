import { describe, expect, it } from "vitest";
import { hashKey, type Backend, type Overview, type TokenResult } from "../src/account.ts";
import { EdgeCache, handle, type AppConfig } from "../src/app.ts";
import { OAUTH_BETA } from "../src/proxy.ts";
import { SESSION_COOKIE, issueSession } from "../../src/session.ts";

const PASSWORD = "correct-horse-battery-staple-0123456789";
const NOW = 1_800_000_000;
const KEY = "sk-s2a-client-key";
const ORIGIN = "https://gateway.example";

class FakeBackend implements Backend {
  hashes = new Set<string>();
  tokenResult: TokenResult = { ok: true, accessToken: "access-1", expiresAt: NOW + 3600 };
  calls: string[] = [];
  invalidated: string[] = [];
  finishError: string | null = null;

  async keyValid(hash: string) {
    this.calls.push("keyValid");
    return this.hashes.has(hash);
  }
  async token() {
    this.calls.push("token");
    return this.tokenResult;
  }
  async invalidate(accessToken: string) {
    this.invalidated.push(accessToken);
  }
  async overview(): Promise<Overview> {
    return { account: null, keys: [] };
  }
  async createKey(name: string) {
    this.calls.push(`createKey:${name}`);
    return "sk-s2a-new";
  }
  async revokeKey(id: number) {
    this.calls.push(`revokeKey:${id}`);
  }
  async startLogin() {
    return "https://claude.ai/oauth/authorize?state=s";
  }
  async finishLogin(callback: string) {
    this.calls.push(`finishLogin:${callback}`);
    return this.finishError;
  }
  async disconnect() {
    this.calls.push("disconnect");
  }
  async attemptAllowed() {
    return true;
  }
}

async function setup(upstream: (request: Request) => Promise<Response> = async () => new Response("{}")) {
  const backend = new FakeBackend();
  backend.hashes.add(await hashKey(KEY));
  const seen: Request[] = [];
  const config: AppConfig = {
    backend,
    dashboardPassword: PASSWORD,
    nowSeconds: () => NOW,
    upstream: async (request) => {
      seen.push(request);
      return upstream(request);
    },
    cache: new EdgeCache(),
  };
  return { backend, seen, config };
}

function at(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

function messages(headers: Record<string, string> = {}, body = '{"model":"claude-sonnet-5-5","max_tokens":8,"messages":[]}'): Request {
  return at("/v1/messages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

async function cookie(): Promise<string> {
  return `${SESSION_COOKIE}=${await issueSession(PASSWORD, NOW)}`;
}

function form(fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() };
}

describe("API proxy", () => {
  it("refuses a missing or unknown key without calling Anthropic", async () => {
    const { config, seen } = await setup();
    for (const request of [messages(), messages({ "x-api-key": "wrong" })]) {
      const response = await handle(request, config);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { type: "authentication_error" } });
    }
    expect(seen).toHaveLength(0);
  });

  it("sends the subscription token, the OAuth beta and only safe headers", async () => {
    const { config, seen } = await setup();
    const response = await handle(
      messages({
        "x-api-key": KEY,
        "anthropic-beta": "claude-code-20250219, interleaved-thinking-2025-05-14",
        "user-agent": "claude-cli/2.1.0 (external, cli)",
        "x-app": "cli",
        "x-stainless-lang": "js",
        cookie: "session=secret",
        "cf-connecting-ip": "1.2.3.4",
      }),
      config,
    );
    expect(response.status).toBe(200);
    const [sent] = seen;
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("authorization")).toBe("Bearer access-1");
    expect(sent?.headers.get("x-api-key")).toBeNull();
    expect(sent?.headers.get("anthropic-beta")).toBe(`claude-code-20250219,interleaved-thinking-2025-05-14,${OAUTH_BETA}`);
    expect(sent?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent?.headers.get("user-agent")).toBe("claude-cli/2.1.0 (external, cli)");
    expect(sent?.headers.get("x-app")).toBe("cli");
    expect(sent?.headers.get("x-stainless-lang")).toBe("js");
    expect(sent?.headers.get("cookie")).toBeNull();
    expect(sent?.headers.get("cf-connecting-ip")).toBeNull();
    expect(await sent?.text()).toContain("claude-sonnet-5-5");
  });

  it("accepts the key as a bearer token and keeps the query string", async () => {
    const { config, seen } = await setup();
    await handle(at("/v1/messages/count_tokens?beta=true", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: "{}" }), config);
    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
  });

  it("streams the answer back untouched, minus cookies", async () => {
    const events = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    const { config } = await setup(async () => new Response(events, { headers: { "content-type": "text/event-stream", "set-cookie": "a=b", "request-id": "req_1" } }));
    const response = await handle(messages({ "x-api-key": KEY }), config);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("request-id")).toBe("req_1");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe(events);
  });

  it("caches the key check and the token in the isolate", async () => {
    const { config, backend } = await setup();
    await handle(messages({ "x-api-key": KEY }), config);
    await handle(messages({ "x-api-key": KEY }), config);
    expect(backend.calls).toEqual(["keyValid", "token"]);
  });

  it("drops the token and tells the store when Anthropic refuses it", async () => {
    const { config, backend } = await setup(async () => Response.json({ type: "error" }, { status: 401 }));
    const response = await handle(messages({ "x-api-key": KEY }), config);
    expect(response.status).toBe(401);
    expect(backend.invalidated).toEqual(["access-1"]);
    expect(config.cache.token).toBeNull();
  });

  it("explains a missing Claude login in Anthropic's error shape", async () => {
    const { config, backend, seen } = await setup();
    backend.tokenResult = { ok: false, status: 503, message: "No Claude account is connected yet." };
    const response = await handle(messages({ "x-api-key": KEY }), config);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ type: "error", error: { type: "api_error", message: "No Claude account is connected yet." } });
    expect(seen).toHaveLength(0);
  });

  it("serves only the Claude endpoints, with their methods", async () => {
    const { config } = await setup();
    expect((await handle(at("/v1/models", { headers: { "x-api-key": KEY } }), config)).status).toBe(200);
    expect((await handle(at("/v1/messages", { headers: { "x-api-key": KEY } }), config)).status).toBe(405);
    expect((await handle(at("/v1/chat/completions", { method: "POST", headers: { "x-api-key": KEY } }), config)).status).toBe(404);
  });
});

describe("dashboard", () => {
  it("sends visitors to sign in, then signs them in", async () => {
    const { config } = await setup();
    expect((await handle(at("/"), config)).headers.get("location")).toBe("/login");
    const wrong = await handle(at("/login", form({ password: "nope" })), config);
    expect(wrong.status).toBe(401);
    const right = await handle(at("/login", form({ password: PASSWORD })), config);
    expect(right.status).toBe(303);
    expect(right.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=.+; Path=/; Secure; HttpOnly; SameSite=Strict`));
  });

  it("shows the dashboard to a signed-in visitor", async () => {
    const { config } = await setup();
    const response = await handle(at("/", { headers: { cookie: await cookie() } }), config);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connect Claude");
  });

  it("refuses dashboard posts from another origin or without a session", async () => {
    const { config, backend } = await setup();
    const foreign = await handle(at("/dashboard", form({ action: "disconnect" }, { origin: "https://evil.example", cookie: await cookie() })), config);
    expect(foreign.status).toBe(404);
    const anonymous = await handle(at("/dashboard", form({ action: "disconnect" })), config);
    expect(anonymous.headers.get("location")).toBe("/login");
    expect(backend.calls).toEqual([]);
  });

  it("creates a key and shows it once, escaped", async () => {
    const { config, backend } = await setup();
    const response = await handle(at("/dashboard", form({ action: "create-key", name: "<laptop>" }, { cookie: await cookie() })), config);
    expect(await response.text()).toContain("sk-s2a-new");
    expect(backend.calls).toEqual(["createKey:<laptop>"]);
  });

  it("starts and finishes a Claude login", async () => {
    const { config, backend } = await setup();
    const started = await handle(at("/dashboard", form({ action: "start-login" }, { cookie: await cookie() })), config);
    expect(await started.text()).toContain("https://claude.ai/oauth/authorize?state=s");
    config.cache.token = { value: "old", expiresAt: NOW + 3600 };
    const finished = await handle(at("/dashboard", form({ action: "finish-login", callback: "abc#s" }, { cookie: await cookie() })), config);
    expect(await finished.text()).toContain("Claude account connected.");
    expect(backend.calls).toContain("finishLogin:abc#s");
    expect(config.cache.token).toBeNull();
    backend.finishError = "Login failed. <b>";
    const failed = await handle(at("/dashboard", form({ action: "finish-login", callback: "x#y" }, { cookie: await cookie() })), config);
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain("Login failed. &lt;b&gt;");
  });
});

// Workers Free allows 10 ms of CPU per request. Waiting on Anthropic doesn't count, so what
// matters is the gateway's own work on a large Claude Code request. The body is never parsed,
// so this stays far under budget even at several hundred KB.
describe("CPU budget", () => {
  it("handles a 600 KB Claude Code request well under 10 ms of CPU", async () => {
    const history = Array.from({ length: 400 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "x".repeat(1500) }));
    const body = JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 32000, stream: true, messages: history });
    expect(body.length).toBeGreaterThan(600_000);
    const { config } = await setup(async (request) => {
      await request.arrayBuffer();
      return new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const cpuMs = async (work: () => Promise<unknown>) => {
      await work();
      const runs = 50;
      const start = process.cpuUsage();
      for (let run = 0; run < runs; run += 1) await work();
      const used = process.cpuUsage(start);
      return (used.user + used.system) / 1000 / runs;
    };
    // The test's own cost of building and draining the body, which the Workers runtime does natively.
    const baseline = await cpuMs(() => messages({ "x-api-key": KEY }, body).arrayBuffer());
    const total = await cpuMs(async () => (await handle(messages({ "x-api-key": KEY }, body), config)).text());
    console.log(`CPU per 600 KB request: ${total.toFixed(2)} ms in all, ${(total - baseline).toFixed(2)} ms in the gateway`);
    expect(total - baseline).toBeLessThan(5);
  });
});
