import { describe, expect, it } from "vitest";
import { hashKey, type Backend, type TokenResult } from "../src/account.ts";
import { EdgeCache, handle, type AppConfig } from "../src/app.ts";
import { upstreamCredentials, type LoginEntry, type RoutingTable } from "../src/providers.ts";
import { OAUTH_BETA } from "../src/proxy.ts";
import { SESSION_COOKIE, issueSession } from "../src/session.ts";
import { routingSettings, type Cooldown, type CooldownEvent } from "../src/routing.ts";
import type { UsageRecord } from "../src/usage.ts";

const PASSWORD = "correct-horse-battery-staple-0123456789";
const NOW = 1_800_000_000;
const KEY = "sk-s2a-client-key";
const ORIGIN = "https://gateway.example";
const MANAGEMENT_KEY = "m".repeat(40);

class FakeBackend implements Backend {
  hashes = new Set<string>();
  tokenResult: TokenResult = { ok: true, accessToken: "access-1", expiresAt: NOW + 3600 };
  calls: string[] = [];
  invalidated: string[] = [];
  managed: Request[] = [];
  answer: Response = Response.json({ status: "ok" });

  async keyValid(hash: string) {
    this.calls.push("keyValid");
    return this.hashes.has(hash);
  }
  // Named logins get a token of their own, unless a test sets one.
  named: Record<string, TokenResult> = {};
  async token(name?: string) {
    this.calls.push(name === undefined ? "token" : `token:${name}`);
    if (name === undefined) return this.tokenResult;
    return this.named[name] ?? { ok: true, accessToken: `access-${name}`, expiresAt: NOW + 3600, name };
  }
  codexResult: TokenResult = { ok: true, accessToken: "chatgpt-1", expiresAt: NOW + 3600, accountId: "acct-1" };
  async codexToken(name?: string) {
    this.calls.push(name === undefined ? "codexToken" : `codexToken:${name}`);
    if (name === undefined) return this.codexResult;
    return this.named[name] ?? { ok: true, accessToken: `chatgpt-${name}`, expiresAt: NOW + 3600, accountId: `acct-${name}`, name };
  }
  async invalidate(accessToken: string) {
    this.invalidated.push(accessToken);
  }
  async attemptAllowed() {
    return true;
  }
  table: RoutingTable = { credentials: [], claudeOAuth: true, codexOAuth: false };
  async routing() {
    this.calls.push("routing");
    return this.table;
  }
  async manage(request: Request) {
    this.managed.push(request);
    return this.answer.clone();
  }
  recorded: UsageRecord[] = [];
  async record(records: UsageRecord[]) {
    this.recorded.push(...records);
  }
  cooled: CooldownEvent[] = [];
  async cool(events: CooldownEvent[]) {
    this.cooled.push(...events);
  }
}

async function setup(upstream: (request: Request) => Promise<Response> = async () => new Response("{}")) {
  const backend = new FakeBackend();
  backend.hashes.add(await hashKey(KEY));
  const seen: Request[] = [];
  const later: Promise<unknown>[] = [];
  const config: AppConfig = {
    backend,
    dashboardPassword: PASSWORD,
    managementKey: MANAGEMENT_KEY,
    nowSeconds: () => NOW,
    upstream: async (request) => {
      seen.push(request);
      return upstream(request);
    },
    panel: async () => new Response("<html>CPA panel</html>", { headers: { "content-type": "text/html" } }),
    cache: new EdgeCache(),
    waitUntil: (promise) => later.push(promise),
    usageFlushMs: 0,
  };
  // Waits for the work the gateway left running after its responses.
  const settle = async () => {
    while (later.length > 0) await later.shift();
  };
  return { backend, seen, config, settle };
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

  it("never forwards the gateway key, even from the query string", async () => {
    const { config, seen } = await setup();
    await handle(at(`/v1/messages?beta=true&key=${KEY}`, { method: "POST", body: "{}" }), config);
    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect([...(seen[0]?.headers.values() ?? [])].join(" ")).not.toContain(KEY);
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
    expect(backend.calls).toEqual(["keyValid", "routing", "token"]);
  });

  it("asks the store for the token again after a minute, so a disabled login stops being used", async () => {
    const { config, backend } = await setup();
    await handle(messages({ "x-api-key": KEY }), config);
    backend.tokenResult = { ok: true, accessToken: "access-2", expiresAt: NOW + 3600 };
    const later = { ...config, nowSeconds: () => NOW + 61 };
    await handle(messages({ "x-api-key": KEY }), later);
    expect(backend.calls.filter((call) => call === "token")).toHaveLength(2);
    expect(config.cache.tokens.get("claude:")?.value).toBe("access-2");
  });

  it("drops the token and tells the store when Anthropic refuses it", async () => {
    const { config, backend } = await setup(async () => Response.json({ type: "error" }, { status: 401 }));
    const response = await handle(messages({ "x-api-key": KEY }), config);
    expect(response.status).toBe(401);
    expect(backend.invalidated).toEqual(["access-1"]);
    expect(config.cache.tokens.size).toBe(0);
  });

  it("explains a missing Claude login in Anthropic's error shape", async () => {
    const { config, backend, seen } = await setup();
    backend.tokenResult = { ok: false, status: 503, message: "No Claude account is connected yet." };
    const response = await handle(messages({ "x-api-key": KEY }), config);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ type: "error", error: { type: "api_error", message: "No Claude account is connected yet." } });
    expect(seen).toHaveLength(0);
  });

  it("checks each endpoint's method", async () => {
    const { config } = await setup();
    expect((await handle(at("/v1/models", { headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" } }), config)).status).toBe(200);
    expect((await handle(at("/v1/messages", { headers: { "x-api-key": KEY } }), config)).status).toBe(405);
    expect((await handle(at("/v1/embeddings", { method: "POST", headers: { "x-api-key": KEY } }), config)).status).toBe(404);
  });
});

const PROVIDERS = {
  "api-keys": {
    "openai-compatibility": [
      {
        name: "router",
        "base-url": "https://router.example/api/v1/",
        headers: { "X-Title": "gateway", "X-Session": "$x-session" },
        models: [{ name: "vendor/kimi-k2:free", alias: "kimi" }, { name: "deepseek-v3" }],
        keys: [{ "api-key": "sk-router-1", weight: 3 }, { "api-key": "sk-router-2" }],
      },
    ],
    gemini: [{ name: "g", keys: [{ "api-key": "AIza-1" }], "excluded-models": ["*-pro"] }],
    claude: [{ name: "c", prefix: "work", keys: [{ "api-key": "sk-ant-1" }] }],
    codex: [{ name: "x", "base-url": "https://api.openai.com/v1", keys: [{ "api-key": "sk-openai" }] }],
  },
};

async function providersSetup(upstream: (request: Request) => Promise<Response> = async () => new Response("{}")) {
  const fixture = await setup(upstream);
  fixture.backend.table = { credentials: upstreamCredentials(PROVIDERS), claudeOAuth: true, codexOAuth: false };
  return fixture;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return at(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, ...headers }, body: JSON.stringify(body) });
}

describe("API-key providers", () => {
  it("reads CPA's api-keys groups, with key overrides and defaults", () => {
    const credentials = upstreamCredentials(PROVIDERS);
    expect(credentials.map((credential) => [credential.id, credential.baseUrl])).toEqual([
      ["claude/c/0", "https://api.anthropic.com"],
      ["gemini/g/0", "https://generativelanguage.googleapis.com"],
      ["codex/x/0", "https://api.openai.com/v1"],
      ["openai-compatibility/router/0", "https://router.example/api/v1"],
      ["openai-compatibility/router/1", "https://router.example/api/v1"],
    ]);
    expect(upstreamCredentials({ "api-keys": { claude: [{ "base-url": "http://plain.example", keys: [{ "api-key": "k" }] }] } })).toEqual([]);
  });

  it("sends an OpenAI chat request to the provider serving the alias, with its upstream name", async () => {
    const { config, seen } = await providersSetup();
    const response = await handle(post("/v1/chat/completions", { model: "kimi", messages: [] }, { "x-session": "s-1" }), config);
    expect(response.status).toBe(200);
    const [sent] = seen;
    expect(sent?.url).toBe("https://router.example/api/v1/chat/completions");
    expect(sent?.headers.get("authorization")).toBe("Bearer sk-router-1");
    expect(sent?.headers.get("x-title")).toBe("gateway");
    expect(sent?.headers.get("x-session")).toBe("s-1");
    expect(await sent?.json()).toEqual({ model: "vendor/kimi-k2:free", messages: [] });
  });

  it("finds the model wherever the client put it, and rewrites only that field", async () => {
    const { config, seen } = await providersSetup();
    await handle(post("/v1/chat/completions", { messages: [{ role: "user", content: '"model":"kimi"' }], model: "kimi" }), config);
    expect(await seen[0]?.json()).toEqual({ messages: [{ role: "user", content: '"model":"kimi"' }], model: "vendor/kimi-k2:free" });
    await handle(at("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${KEY}` }, body: ' { "model" : "k\\u0069mi", "x": "\\"" }' }), config);
    expect(await seen[1]?.text()).toBe(' { "model" : "vendor/kimi-k2:free", "x": "\\"" }');
  });

  it("takes keys in turn, and by weight under weighted-round-robin, as CPA's strategies do", async () => {
    const plain = await providersSetup();
    for (let turn = 0; turn < 4; turn += 1) await handle(post("/v1/chat/completions", { model: "deepseek-v3" }), plain.config);
    expect(plain.seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer sk-router-1", "Bearer sk-router-2", "Bearer sk-router-1", "Bearer sk-router-2"]);
    const weighted = await providersSetup();
    weighted.backend.table = { ...weighted.backend.table, settings: routingSettings({ routing: { strategy: "weighted-round-robin" } }) };
    for (let turn = 0; turn < 4; turn += 1) await handle(post("/v1/chat/completions", { model: "deepseek-v3" }), weighted.config);
    expect(weighted.seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer sk-router-1", "Bearer sk-router-1", "Bearer sk-router-1", "Bearer sk-router-2"]);
    const filling = await providersSetup();
    filling.backend.table = { ...filling.backend.table, settings: routingSettings({ routing: { strategy: "fill-first" } }) };
    for (let turn = 0; turn < 3; turn += 1) await handle(post("/v1/chat/completions", { model: "deepseek-v3" }), filling.config);
    expect(filling.seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer sk-router-1", "Bearer sk-router-1", "Bearer sk-router-1"]);
  });

  it("tries the next key when one is rate limited", async () => {
    let calls = 0;
    const { config, seen } = await providersSetup(async () => (calls++ === 0 ? new Response("slow down", { status: 429 }) : Response.json({ ok: true })));
    const response = await handle(post("/v1/chat/completions", { model: "kimi" }), config);
    expect(response.status).toBe(200);
    expect(seen.map((request) => request.headers.get("authorization"))).toEqual(["Bearer sk-router-1", "Bearer sk-router-2"]);
  });

  it("serves Gemini clients, with the gateway key taken from ?key= and not forwarded", async () => {
    const { config, seen } = await providersSetup();
    const request = at(`/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${KEY}`, { method: "POST", body: "{}" });
    expect((await handle(request, config)).status).toBe(200);
    expect(seen[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(seen[0]?.headers.get("x-goog-api-key")).toBe("AIza-1");
    const refused = await handle(at(`/v1beta/models/gemini-2.5-pro:generateContent?key=${KEY}`, { method: "POST", body: "{}" }), config);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 400, status: "INVALID_ARGUMENT" } });
  });

  it("sends Responses requests to Codex keys", async () => {
    const { config, seen } = await providersSetup();
    await handle(post("/v1/responses", { model: "gpt-5.5", input: "hi" }), config);
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-openai");
  });

  it("reaches a prefixed Claude key with prefix/model, and the subscription login otherwise", async () => {
    const { config, seen } = await providersSetup();
    await handle(post("/v1/messages", { model: "work/claude-sonnet-5-5", messages: [] }, { "anthropic-version": "2023-06-01" }), config);
    expect(seen[0]?.headers.get("x-api-key")).toBe("sk-ant-1");
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(await seen[0]?.json()).toMatchObject({ model: "claude-sonnet-5-5" });
    await handle(post("/v1/messages", { model: "not-a-claude-model", messages: [] }), config);
    expect(seen[1]?.headers.get("authorization")).toBe("Bearer access-1");
  });

  it("explains a model no provider serves, in the client's error shape", async () => {
    const { config, backend, seen } = await providersSetup();
    const unknown = await handle(post("/v1/chat/completions", { model: "nothing" }), config);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { type: "invalid_request_error", message: expect.stringMatching(/No provider is configured for model nothing/) } });
    const wrongShape = await handle(post("/v1/chat/completions", { model: "gemini-2.5-flash" }), config);
    expect(await wrongShape.json()).toMatchObject({ error: { message: expect.stringMatching(/gemini provider, which doesn't take this request format yet/) } });
    backend.table = { ...backend.table, claudeOAuth: false };
    config.cache.forgetConfig();
    expect((await handle(post("/v1/messages", { model: "x" }), config)).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("lists every login's and key's models in each client's shape", async () => {
    const { config, backend, seen, settle } = await providersSetup(async () => new Response("unavailable", { status: 503 }));
    backend.table = { ...backend.table, codexOAuth: true, codexPlans: ["free"] };
    const openai = (await (await handle(at("/v1/models", { headers: { authorization: `Bearer ${KEY}` } }), config)).json()) as { object: string; data: { id: string; object: string; owned_by: string }[] };
    const ids = openai.data.map((model) => model.id);
    // The Claude login and the Claude key share CPA's Claude catalog; the key's prefix adds its own names.
    expect(ids.filter((id) => id === "claude-sonnet-4-6")).toHaveLength(1);
    expect(ids).toContain("work/claude-sonnet-4-6");
    // The ChatGPT login lists its plan's catalog, the Codex key Pro's.
    expect(ids).toContain("gpt-6-luna");
    expect(ids).toContain("gpt-6-astra");
    expect(ids).toEqual(expect.arrayContaining(["kimi", "deepseek-v3", "gemini-2.5-flash"]));
    expect(ids).not.toContain("gemini-2.5-pro");
    expect(new Set(ids).size).toBe(ids.length);
    expect(openai.data.find((model) => model.id === "kimi")).toMatchObject({ object: "model", owned_by: "router" });
    // The catalog refresh runs after the response, and a failed one keeps the embedded catalog.
    await settle();
    expect(seen.map((request) => request.url)).toEqual(["https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json"]);

    const claude = (await (await handle(at("/v1/models", { headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" } }), config)).json()) as { data: { id: string; display_name: string; type: string; max_tokens: number }[]; first_id: string; has_more: boolean };
    expect(claude.data.map((model) => model.id).sort()).toEqual([...ids].sort());
    expect(claude.has_more).toBe(false);
    expect(claude.first_id).toBe(claude.data[0]?.id);
    const names = claude.data.map((model) => model.display_name);
    expect(names).toEqual([...names].sort());
    expect(claude.data.find((model) => model.id === "kimi")).toMatchObject({ type: "model", display_name: "kimi", max_tokens: 64000 });

    const gemini = (await (await handle(at(`/v1beta/models?key=${KEY}`), config)).json()) as { models: { name: string; supportedGenerationMethods: string[] }[] };
    expect(gemini.models).toHaveLength(ids.length);
    expect(gemini.models.find((model) => model.name === "models/kimi")?.supportedGenerationMethods).toEqual(["generateContent"]);
    const one = await handle(at(`/v1beta/models/gemini-2.5-flash?key=${KEY}`), config);
    expect(await one.json()).toMatchObject({ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576 });
    expect((await handle(at(`/v1beta/models/%E0%A4%A?key=${KEY}`), config)).status).toBe(404);
    const missing = await handle(at(`/v1beta/models/gemini-2.5-pro?key=${KEY}`), config);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { status: string } }).error.status).toBe("NOT_FOUND");
    // No second catalog download within three hours.
    expect(seen).toHaveLength(1);
  });

  it("lists nothing when nothing is configured", async () => {
    const { config, backend } = await setup();
    backend.table = { credentials: [], claudeOAuth: false, codexOAuth: false };
    expect(await (await handle(at("/v1/models", { headers: { authorization: `Bearer ${KEY}` } }), config)).json()).toEqual({ object: "list", data: [] });
    expect(await (await handle(at("/v1/models", { headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" } }), config)).json()).toEqual({ data: [], has_more: false, first_id: "", last_id: "" });
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

  it("accepts a sign-in whose Origin is hidden but Sec-Fetch-Site says same-origin", async () => {
    const { config } = await setup();
    const hidden = await handle(at("/login", form({ password: PASSWORD }, { origin: "null", "sec-fetch-site": "same-origin" })), config);
    expect(hidden.status).toBe(303);
    const crossSite = await handle(at("/login", form({ password: PASSWORD }, { origin: "null", "sec-fetch-site": "cross-site" })), config);
    expect(crossSite.status).toBe(404);
  });

  it("serves CPA's dashboard only to a signed-in visitor", async () => {
    const { config } = await setup();
    expect((await handle(at("/management.html"), config)).headers.get("location")).toBe("/login");
    expect((await handle(at("/", { headers: { cookie: await cookie() } }), config)).headers.get("location")).toBe("/management.html");
    const panel = await handle(at("/management.html", { headers: { cookie: await cookie() } }), config);
    expect(await panel.text()).toContain("CPA panel");
    expect(panel.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(panel.headers.get("x-frame-options")).toBe("DENY");
  });

  it("refuses a sign-in body over the limit even without a Content-Length", async () => {
    const { config } = await setup();
    const big = new TextEncoder().encode(`password=${PASSWORD}&pad=${"a".repeat(8192)}`);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const request = at("/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body, duplex: "half" } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    expect((await handle(request, config)).status).toBe(401);
  });

  it("signs out", async () => {
    const { config } = await setup();
    const response = await handle(at("/logout", { method: "POST" }), config);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("management API", () => {
  const managementCall = async (path: string, headers: Record<string, string>, init: RequestInit = {}) => at(path, { ...init, headers: { cookie: await cookie(), ...headers } });

  it("needs both the sign-in cookie and the management key", async () => {
    const { config, backend } = await setup();
    expect((await handle(at("/v8/management/config", { headers: { authorization: `Bearer ${MANAGEMENT_KEY}` } }), config)).status).toBe(401);
    expect((await handle(await managementCall("/v8/management/config", { authorization: "Bearer wrong" }), config)).status).toBe(401);
    expect(backend.managed).toHaveLength(0);
    const response = await handle(await managementCall("/v8/management/config", { "x-management-key": MANAGEMENT_KEY }), config);
    expect(response.status).toBe(200);
    expect(backend.managed[0]?.headers.get("cookie")).toBeNull();
  });

  it("is off until its own long enough key is set, never the sign-in password", async () => {
    const { config, backend } = await setup();
    for (const managementKey of ["", "short", PASSWORD]) {
      const off = { ...config, managementKey };
      const response = await handle(await managementCall("/v8/management/config", { authorization: `Bearer ${managementKey}` }), off);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: expect.stringMatching(/MANAGEMENT_KEY .*different from DASHBOARD_PASSWORD/) });
    }
    // Signed-out callers learn nothing about the setup.
    expect((await handle(at("/v8/management/config"), { ...config, managementKey: "" })).status).toBe(401);
    expect(backend.managed).toHaveLength(0);
  });

  it("answers the dashboard's v0 probe with the v8 config", async () => {
    const { config, backend } = await setup();
    await handle(await managementCall("/v0/management/config?x=1", { authorization: `Bearer ${MANAGEMENT_KEY}` }), config);
    expect(backend.managed[0]?.url).toBe(`${ORIGIN}/v8/management/config?x=1`);
  });

  it("forgets cached keys after a config write", async () => {
    const { config } = await setup();
    config.cache.keys.set("hash", NOW + 60);
    await handle(await managementCall("/v8/management/config", { authorization: `Bearer ${MANAGEMENT_KEY}` }, { method: "PATCH", body: "{}" }), config);
    expect(config.cache.keys.size).toBe(0);
  });

  it("forgets the cached token after a credential change", async () => {
    const { config } = await setup();
    config.cache.tokens.set("claude:", { value: "old", name: "claude-a.json", accountId: "", expiresAt: NOW + 3600, cachedUntil: NOW + 60 });
    await handle(await managementCall("/v8/management/credentials?name=claude-a.json", { authorization: `Bearer ${MANAGEMENT_KEY}` }, { method: "DELETE" }), config);
    expect(config.cache.tokens.size).toBe(0);
  });
});

describe("usage records", () => {
  it("logs each API request and counts the login or key that served it, without the query", async () => {
    const { config, backend, settle } = await setup(async () => new Response("{}", { status: 200 }));
    backend.tokenResult = { ok: true, accessToken: "access-1", expiresAt: NOW + 3600, name: "claude-me.json" };
    await handle(messages({ "x-api-key": KEY, "cf-connecting-ip": "1.2.3.4" }), config);
    await handle(at(`/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY}`, { method: "POST", body: "{}" }), config);
    await handle(messages({ "x-api-key": "wrong" }), config);
    await settle();
    expect(backend.recorded.map((record) => record.attempts)).toEqual([[{ key: "file:claude-me.json", ok: true }], [], []]);
    const [served, gemini, refused] = backend.recorded.map((record) => record.line);
    expect(served).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[[0-9a-f]{8}\] \[info \] 200 \| +\d+ms \| +1\.2\.3\.4 \| POST +"\/v1\/messages" provider=claude$/);
    expect(gemini).toContain('"/v1beta/models/gemini-2.5-flash:generateContent"');
    expect(gemini).not.toContain(KEY);
    expect(refused).toContain("[warn ] 401");
  });

  it("counts every attempt on API keys, including ones retried elsewhere", async () => {
    let calls = 0;
    const { config, backend, settle } = await providersSetup(async () => (calls++ === 0 ? new Response("busy", { status: 429 }) : Response.json({})));
    backend.table = { ...backend.table, claudeOAuth: false };
    await handle(post("/v1/chat/completions", { model: "kimi", messages: [] }), config);
    await settle();
    expect(backend.recorded[0]?.attempts).toEqual([
      { key: expect.stringMatching(/^router\nhttps:\/\/router\.example\/api\/v1\|sk-router-[12]$/), ok: false },
      { key: expect.stringMatching(/^router\nhttps:\/\/router\.example\/api\/v1\|sk-router-[12]$/), ok: true },
    ]);
    expect(backend.recorded[0]?.line).toContain('provider=openai-compatibility model="kimi"');
  });
});

describe("OAuth callback", () => {
  it("needs sign-in, then hands the code to the store", async () => {
    const { config, backend } = await setup();
    expect((await handle(at("/callback?code=c&state=s"), config)).status).toBe(401);
    config.cache.tokens.set("claude:", { value: "old", name: "claude-a.json", accountId: "", expiresAt: NOW + 3600, cachedUntil: NOW + 60 });
    const done = await handle(at("/callback?code=c&state=s", { headers: { cookie: await cookie() } }), config);
    expect(await done.text()).toContain("Login received");
    expect(backend.managed[0]?.url).toBe(`${ORIGIN}/v8/management/oauth/callback?code=c&state=s`);
    expect(config.cache.tokens.size).toBe(0);
  });

  it("shows the store's error, escaped", async () => {
    const { config, backend } = await setup();
    backend.answer = Response.json({ status: "error", error: "unknown <state>" }, { status: 404 });
    const failed = await handle(at("/anthropic/callback?code=c&state=s", { headers: { cookie: await cookie() } }), config);
    expect(failed.status).toBe(404);
    expect(await failed.text()).toContain("unknown &lt;state&gt;");
  });
});

// The gateway's own CPU per request: each run's cost minus the test's cost of building and
// draining the same request. The median keeps a stray garbage collection out of the result.
async function gatewayCpuMs(request: () => Request, config: AppConfig): Promise<number> {
  const samples: number[] = [];
  for (let run = 0; run < 33; run += 1) {
    const start = process.cpuUsage();
    await request().arrayBuffer();
    const middle = process.cpuUsage();
    await (await handle(request(), config)).text();
    const end = process.cpuUsage();
    if (run >= 3) samples.push((end.user - middle.user + end.system - middle.system - (middle.user - start.user + middle.system - start.system)) / 1000);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

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

  it("reads and rewrites a 600 KB request for an API-key provider within budget", async () => {
    const history = Array.from({ length: 400 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "x".repeat(1500) }));
    const body = JSON.stringify({ model: "kimi", stream: true, messages: history });
    const { config } = await providersSetup(async (request) => {
      await request.arrayBuffer();
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const request = () => post("/v1/chat/completions", JSON.parse(body));
    const gateway = await gatewayCpuMs(request, config);
    console.log(`CPU per 600 KB rewritten request: ${gateway.toFixed(2)} ms in the gateway`);
    expect(gateway).toBeLessThan(8);
  });

  it("reads a 600 KB Claude Code request once for routing across two logins, within budget", async () => {
    const history = Array.from({ length: 400 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "x".repeat(1500) }));
    const body = JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 32000, stream: true, messages: history });
    const { config, backend } = await setup(async (request) => {
      await request.arrayBuffer();
      return new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const login = (name: string): LoginEntry => ({ name, provider: "claude", priority: 0, weight: 1, prefix: "", disableCooling: null, requestRetry: null });
    backend.table = { credentials: [], claudeOAuth: true, codexOAuth: false, logins: [login("a.json"), login("b.json")] };
    const gateway = await gatewayCpuMs(() => messages({ "x-api-key": KEY }, body), config);
    console.log(`CPU per 600 KB request across two logins: ${gateway.toFixed(2)} ms in the gateway`);
    expect(gateway).toBeLessThan(5);
  });
});

describe("ChatGPT (Codex) logins", () => {
  const sse = (events: unknown[]) => new Response(events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

  async function codexSetup(upstream?: (request: Request) => Promise<Response>) {
    const fixture = await setup(upstream);
    fixture.backend.table = { credentials: [], claudeOAuth: false, codexOAuth: true };
    return fixture;
  }

  it("passes Codex CLI requests through with the login's token and account", async () => {
    const { config, seen } = await codexSetup();
    const body = { model: "gpt-5.5-codex", stream: true, store: false, input: [], previous_response_id: "kept-for-codex" };
    const response = await handle(post("/backend-api/codex/responses", body, { originator: "codex_cli_rs", "session_id": "s-9", "x-codex-turn-state": "t" }), config);
    expect(response.status).toBe(200);
    const [sent] = seen;
    expect(sent?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(sent?.headers.get("authorization")).toBe("Bearer chatgpt-1");
    expect(sent?.headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(sent?.headers.get("originator")).toBe("codex_cli_rs");
    expect(sent?.headers.get("session_id")).toBe("s-9");
    expect(sent?.headers.get("x-codex-turn-state")).toBe("t");
    expect(await sent?.json()).toEqual(body);
  });

  it("adapts other Responses clients and answers a non-streaming request from the final event", async () => {
    const final = { id: "resp_1", object: "response", status: "completed", output: [] };
    const { config, seen } = await codexSetup(async () => sse([{ type: "response.created" }, { type: "response.completed", response: final }]));
    const response = await handle(post("/v1/responses", { model: "gpt-5.5", input: "hi", temperature: 0.2, max_output_tokens: 9 }), config);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(final);
    const [sent] = seen;
    expect(sent?.headers.get("originator")).toBe("codex-tui");
    expect(await sent?.json()).toEqual({ model: "gpt-5.5", input: "hi", stream: true, store: false, instructions: "" });
  });

  it("reports a failed response and refreshes a refused token", async () => {
    const failing = await codexSetup(async () => sse([{ type: "response.failed", response: { error: { message: "quota" } } }]));
    const failed = await handle(post("/v1/responses", { model: "gpt-5.5", input: "hi" }), failing.config);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { message: "quota" } });

    const refused = await codexSetup(async () => new Response("no", { status: 401 }));
    expect((await handle(post("/v1/responses", { model: "gpt-5.5", input: "hi", stream: true }), refused.config)).status).toBe(401);
    expect(refused.backend.invalidated).toEqual(["chatgpt-1"]);
    expect(refused.config.cache.tokens.size).toBe(0);
  });

  it("leaves Responses requests alone when no ChatGPT login is on", async () => {
    const { config, backend, seen } = await codexSetup();
    backend.table = { ...backend.table, codexOAuth: false };
    expect((await handle(post("/v1/responses", { model: "gpt-5.5", input: "hi" }), config)).status).toBe(400);
    expect(seen).toEqual([]);
    expect(backend.calls).not.toContain("codexToken");
  });
});

describe("Claude Code on ChatGPT logins and Codex keys", () => {
  const sse = (events: unknown[]) => new Response(events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const answer = () =>
    sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.completed", response: { id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }], usage: { input_tokens: 3, output_tokens: 1 } } },
    ]);

  async function loginSetup(upstream: (request: Request) => Promise<Response> = async () => answer()) {
    const fixture = await setup(upstream);
    fixture.backend.table = { credentials: [], claudeOAuth: true, codexOAuth: true };
    return fixture;
  }

  it("translates a Claude Code request for a ChatGPT model and streams Anthropic events back", async () => {
    const { config, seen } = await loginSetup();
    const body = '{"model":"gpt-5.6-sol","max_tokens":8,"stream":true,"system":"Be brief.","messages":[{"role":"user","content":"hello"}]}';
    const response = await handle(messages({ "x-api-key": KEY, "anthropic-version": "2023-06-01", "x-claude-code-session-id": "s" }, body), config);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text_delta","text":"Hi"');
    expect(text).toContain("event: message_stop");
    const [sent] = seen;
    expect(sent?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(sent?.headers.get("authorization")).toBe("Bearer chatgpt-1");
    expect(sent?.headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(sent?.headers.get("x-api-key")).toBeNull();
    expect(sent?.headers.get("anthropic-version")).toBeNull();
    expect(sent?.headers.get("x-claude-code-session-id")).toBeNull();
    expect(await sent?.json()).toMatchObject({ model: "gpt-5.6-sol", stream: true, store: false, input: [{ role: "developer" }, { role: "user", content: [{ type: "input_text", text: "hello" }] }] });
  });

  it("answers a non-streaming request and counts tokens without an upstream call", async () => {
    const { config, seen } = await loginSetup();
    const whole = await handle(messages({ "x-api-key": KEY }, '{"model":"gpt-5.6-sol","max_tokens":8,"messages":[{"role":"user","content":"hello"}]}'), config);
    expect(await whole.json()).toMatchObject({ type: "message", model: "gpt-5.6-sol", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" });
    const count = await handle(at("/v1/messages/count_tokens", { method: "POST", headers: { "x-api-key": KEY }, body: '{"model":"gpt-5.6-sol","messages":[]}' }), config);
    expect(await count.json()).toEqual({ input_tokens: 10 });
    expect(seen).toHaveLength(1);
  });

  it("returns upstream errors in Anthropic's shape and refreshes a refused token", async () => {
    const { config, backend } = await loginSetup(async () => Response.json({ detail: "Unsupported model" }, { status: 401 }));
    const response = await handle(messages({ "x-api-key": KEY }, '{"model":"gpt-5.6-sol","stream":true,"messages":[]}'), config);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ type: "error", error: { type: "api_error", message: "Unsupported model" } });
    expect(backend.invalidated).toEqual(["chatgpt-1"]);
  });

  it("still sends Claude models to the Claude login, body unread", async () => {
    const { config, seen, backend } = await loginSetup(async () => new Response("{}"));
    await handle(messages({ "x-api-key": KEY }), config);
    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    backend.table = { credentials: [], claudeOAuth: true, codexOAuth: false };
    config.cache.forgetConfig();
    const request = messages({ "x-api-key": KEY });
    const text = request.text.bind(request);
    let read = false;
    request.text = async () => {
      read = true;
      return text();
    };
    await handle(request, config);
    expect(read).toBe(false);
    expect(seen[1]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("serves a Claude request from a Codex API key through the translator", async () => {
    const { config, seen } = await providersSetup(async () => answer());
    const response = await handle(messages({ "x-api-key": KEY }, '{"model":"gpt-5.6-sol","stream":true,"messages":[{"role":"user","content":"hi"}]}'), config);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-openai");
  });

  it("serves Claude Code from an OpenAI-compatible key through the Chat translator", async () => {
    const chat = () => new Response(`data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    const { config, seen } = await providersSetup(async () => chat());
    const response = await handle(messages({ "x-api-key": KEY, "x-session": "s-1" }, '{"model":"kimi","stream":true,"messages":[{"role":"user","content":"hi"}]}'), config);
    const text = await response.text();
    expect(text).toContain('"text_delta","text":"Hi"');
    expect(text).toContain('"stop_reason":"end_turn"');
    const [sent] = seen;
    expect(sent?.url).toBe("https://router.example/api/v1/chat/completions");
    expect(sent?.headers.get("authorization")).toBe("Bearer sk-router-1");
    expect(sent?.headers.get("x-api-key")).toBeNull();
    expect(await sent?.json()).toMatchObject({ model: "vendor/kimi-k2:free", stream: true, messages: [{ role: "user", content: "hi" }] });
  });

  it("serves Claude Code from a Gemini key through the Gemini translator, streamed and whole", async () => {
    const parts = [{ text: "Hi" }];
    const { config, seen } = await providersSetup(async (request) =>
      new URL(request.url).searchParams.get("alt") === "sse"
        ? new Response(`data: ${JSON.stringify({ responseId: "r1", candidates: [{ content: { parts }, finishReason: "STOP" }] })}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ responseId: "r2", candidates: [{ content: { parts }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } }),
    );
    const streamed = await handle(messages({ "x-api-key": KEY, "anthropic-beta": "b" }, '{"model":"gemini-2.5-flash","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'), config);
    const text = await streamed.text();
    expect(text).toContain('"text_delta","text":"Hi"');
    expect(text).toContain("message_stop");
    const [sent] = seen;
    expect(sent?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(sent?.headers.get("x-goog-api-key")).toBe("AIza-1");
    expect(sent?.headers.get("x-api-key")).toBeNull();
    expect(sent?.headers.get("anthropic-beta")).toBeNull();
    expect(await sent?.json()).toEqual({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 64 } });
    const whole = await handle(messages({ "x-api-key": KEY }, '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}]}'), config);
    expect(seen[1]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(await whole.json()).toMatchObject({ id: "msg_r2", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 1 } });
    // Excluded models stay excluded through the translator too.
    await handle(messages({ "x-api-key": KEY }, '{"model":"gemini-2.5-pro","messages":[]}'), config);
    expect(seen[2]?.url).not.toContain("generativelanguage");
  });

  it("serves an OpenAI Chat client from a Claude API key, and explains that logins can't", async () => {
    const claude = () =>
      new Response(
        [
          { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 4 } } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    const { config, seen, backend } = await providersSetup(async () => claude());
    const response = await handle(post("/v1/chat/completions", { model: "work/claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }, { "x-session": "s-1" }), config);
    const text = await response.text();
    expect(text).toContain('"delta":{"content":"Hi"}');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    const [sent] = seen;
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.headers.get("x-api-key")).toBe("sk-ant-1");
    expect(sent?.headers.get("authorization")).toBeNull();
    expect(sent?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(await sent?.json()).toEqual({ model: "claude-sonnet-5-5", max_tokens: 32000, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    backend.table = { credentials: [], claudeOAuth: true, codexOAuth: false };
    config.cache.forgetConfig();
    const login = await handle(post("/v1/chat/completions", { model: "claude-sonnet-5-5", messages: [] }), config);
    expect(login.status).toBe(400);
    expect(await login.json()).toMatchObject({ error: { message: expect.stringMatching(/Claude logins serve Claude Code only/) } });
    expect(seen).toHaveLength(1);
  });

  it("translates a 600 KB Claude Code request within the CPU budget", async () => {
    const history = Array.from({ length: 400 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: "x".repeat(1500) }] }));
    const tools = Array.from({ length: 30 }, (_, index) => ({ name: `tool_${index}`, description: "d".repeat(300), input_schema: { type: "object", properties: { a: { type: "string" } } } }));
    const body = JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 32000, stream: true, tools, messages: history });
    expect(body.length).toBeGreaterThan(600_000);
    const { config } = await loginSetup(async (request) => {
      await request.arrayBuffer();
      return answer();
    });
    const gateway = await gatewayCpuMs(() => messages({ "x-api-key": KEY }, body), config);
    console.log(`CPU per 600 KB translated request: ${gateway.toFixed(2)} ms in the gateway`);
    // Parsing, translating and re-serialising is the costliest path the gateway has (about 6 ms
    // here), so this gate leaves CI machines some room while still catching a regression.
    expect(gateway).toBeLessThan(9);
  });
});

describe("routing across logins and keys", () => {
  const managementCall = async (path: string, headers: Record<string, string>, init: RequestInit = {}) => at(path, { ...init, headers: { cookie: await cookie(), ...headers } });
  const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const login = (name: string, provider: LoginEntry["provider"] = "claude", fields: Partial<LoginEntry> = {}): LoginEntry => ({ name, provider, priority: 0, weight: 1, prefix: "", disableCooling: null, requestRetry: null, ...fields });

  async function loginsSetup(upstream: (request: Request) => Promise<Response>, logins = [login("a.json"), login("b.json")], settings = {}) {
    const fixture = await setup(upstream);
    fixture.backend.table = { credentials: [], claudeOAuth: true, codexOAuth: false, logins, settings: routingSettings(settings) };
    return fixture;
  }

  const tokenOf = (request: Request | undefined) => request?.headers.get("authorization");

  it("moves on to the next Claude login when one is rate limited, and keeps it out until its cooldown ends", async () => {
    const limited = async (request: Request) => (tokenOf(request) === "Bearer access-a.json" ? new Response('{"type":"error"}', { status: 429, headers: { "retry-after": "120" } }) : new Response("{}"));
    const { config, backend, seen, settle } = await loginsSetup(limited);
    expect((await handle(messages({ "x-api-key": KEY }), config)).status).toBe(200);
    expect(seen.map(tokenOf)).toEqual(["Bearer access-a.json", "Bearer access-b.json"]);
    // The next turn would be a.json's, but it is cooling down.
    expect((await handle(messages({ "x-api-key": KEY }), config)).status).toBe(200);
    expect(seen.map(tokenOf).slice(2)).toEqual(["Bearer access-b.json"]);
    await settle();
    expect(backend.cooled).toEqual([{ id: "file:a.json", model: "", until: NOW + 120, reason: "quota", status: 429, level: 0 }]);
    expect(backend.recorded[0]?.attempts).toEqual([
      { key: "file:a.json", ok: false },
      { key: "file:b.json", ok: true },
    ]);
    // Another isolate learns of it from the routing table.
    const other = { ...config, cache: new EdgeCache() };
    backend.table = { ...backend.table, cooldowns: backend.cooled.filter((event): event is Cooldown => !("clear" in event)) };
    await handle(messages({ "x-api-key": KEY }), other);
    expect(seen.map(tokenOf).slice(3)).toEqual(["Bearer access-b.json"]);
  });

  it("answers 429 with Retry-After without calling upstream while every credential cools down", async () => {
    const { config, seen } = await loginsSetup(async () => new Response("{}", { status: 503 }));
    expect((await handle(messages({ "x-api-key": KEY }), config)).status).toBe(503);
    expect(seen).toHaveLength(2);
    const cooling = await handle(messages({ "x-api-key": KEY }), config);
    expect(cooling.status).toBe(429);
    expect(cooling.headers.get("retry-after")).toBe("60");
    expect(await cooling.json()).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    expect(seen).toHaveLength(2);
  });

  it("returns the last upstream error whole when every credential fails", async () => {
    const { config } = await loginsSetup(async (request) => Response.json({ type: "error", error: { message: `down for ${tokenOf(request)}` } }, { status: 529 }));
    const response = await handle(messages({ "x-api-key": KEY }), config);
    expect(response.status).toBe(529);
    expect(await response.json()).toMatchObject({ error: { message: "down for Bearer access-b.json" } });
  });

  it("hands a request error back without trying other credentials or cooling down", async () => {
    const { config, backend, seen, settle } = await loginsSetup(async () => Response.json({ type: "error" }, { status: 400 }));
    expect((await handle(messages({ "x-api-key": KEY }), config)).status).toBe(400);
    expect(seen).toHaveLength(1);
    await settle();
    expect(backend.cooled).toEqual([]);
  });

  it("waits for a short cooldown and runs another round when request-retry allows", async () => {
    let clock = NOW;
    const naps: number[] = [];
    let calls = 0;
    const { config, backend, seen } = await loginsSetup(async () => (calls++ === 0 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : new Response("{}")), [login("a.json")], {
      routing: { retry: { "request-retry": 1, "max-retry-interval": 30 } },
    });
    const timed = { ...config, nowSeconds: () => clock, sleep: async (ms: number) => { naps.push(ms); clock += ms / 1000; } };
    // Two logins, so the body is read and the request can be sent again.
    backend.table = { ...backend.table, logins: [login("a.json"), login("b.json", "claude", { requestRetry: 0 })] };
    backend.named["b.json"] = { ok: false, status: 503, message: "The login b.json has expired." };
    const response = await handle(messages({ "x-api-key": KEY }), timed);
    expect(response.status).toBe(200);
    // a.json is rate limited, b.json can't get a token, then a.json again after its 10 s floor.
    expect(naps).toEqual([10_000]);
    expect(seen.map(tokenOf)).toEqual(["Bearer access-a.json", "Bearer access-a.json"]);
  });

  it("doesn't wait longer than max-retry-interval", async () => {
    const naps: number[] = [];
    const { config, seen } = await loginsSetup(async () => new Response("{}", { status: 429, headers: { "retry-after": "600" } }), undefined, { routing: { retry: { "request-retry": 3, "max-retry-interval": 30 } } });
    const response = await handle(messages({ "x-api-key": KEY }), { ...config, sleep: async (ms: number) => void naps.push(ms) });
    expect(response.status).toBe(429);
    expect(naps).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it("keeps to higher priorities first and leaves disable-cooling logins in rotation", async () => {
    const { config, seen } = await loginsSetup(async () => new Response("{}", { status: 500 }), [login("low.json"), login("high.json", "claude", { priority: 5, disableCooling: true })]);
    await handle(messages({ "x-api-key": KEY }), config);
    expect(seen.map(tokenOf)).toEqual(["Bearer access-high.json", "Bearer access-low.json"]);
    await handle(messages({ "x-api-key": KEY }), config);
    expect(seen.map(tokenOf).slice(2)).toEqual(["Bearer access-high.json"]);
  });

  it("sends prefix/model only to logins with that prefix, with the prefix taken off", async () => {
    const { config, seen } = await loginsSetup(async () => new Response("{}"), [login("home.json"), login("work.json", "claude", { prefix: "team" })]);
    const body = '{"model":"team/claude-sonnet-5-5","max_tokens":8,"messages":[]}';
    expect((await handle(messages({ "x-api-key": KEY }, body), config)).status).toBe(200);
    expect(tokenOf(seen[0])).toBe("Bearer access-work.json");
    expect(await seen[0]?.json()).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("fails over between ChatGPT logins too", async () => {
    const { config, backend, seen } = await setup(async (request) =>
      tokenOf(request) === "Bearer chatgpt-one.json" ? Response.json({ error: { type: "usage_limit_reached", resets_in_seconds: 3600 } }, { status: 429 }) : sse([{ type: "response.completed", response: { id: "r" } }]),
    );
    backend.table = { credentials: [], claudeOAuth: false, codexOAuth: true, logins: [login("one.json", "codex"), login("two.json", "codex")] };
    expect((await handle(post("/v1/responses", { model: "gpt-5.5", input: "hi" }), config)).status).toBe(200);
    expect(seen.map((request) => request.headers.get("chatgpt-account-id"))).toEqual(["acct-one.json", "acct-two.json"]);
    expect(config.cache.cooldowns.find(backend.table, "file:one.json", "")).toMatchObject({ until: NOW + 3600, reason: "quota" });
  });

  it("forgets this isolate's cooldowns after a dashboard change, such as a cooldown reset", async () => {
    let refusals = 1;
    const { config, seen } = await loginsSetup(async (request) => new Response("{}", { status: tokenOf(request) === "Bearer access-a.json" && refusals-- > 0 ? 403 : 200 }));
    await handle(messages({ "x-api-key": KEY }), config);
    await handle(await managementCall("/v8/management/routing/cooldown/reset", { authorization: `Bearer ${MANAGEMENT_KEY}` }, { method: "POST", body: '{"auth_index":"a.json"}' }), config);
    await handle(messages({ "x-api-key": KEY }), config);
    await handle(messages({ "x-api-key": KEY }), config);
    expect(seen.map(tokenOf)).toEqual(["Bearer access-a.json", "Bearer access-b.json", "Bearer access-b.json", "Bearer access-a.json"]);
  });
});
