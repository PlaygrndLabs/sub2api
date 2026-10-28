import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Account } from "../src/account.ts";
import { TOKEN_URL, type Fetcher } from "../src/claude-oauth.ts";
import { configTag } from "../src/config.ts";
import { handleManagement, MANAGEMENT_PREFIX } from "../src/management.ts";
import { Vault, claudeFileData } from "../src/vault.ts";
import { memorySql } from "./sqlite.ts";

const NOW = 1_800_000_000;
const ORIGIN = "https://gateway.example";

function setup(fetcher: Fetcher = async () => new Response("unexpected", { status: 500 })) {
  const vault = new Vault(memorySql());
  const account = new Account(vault, fetcher, () => NOW);
  const call = (method: string, path: string, body?: NonNullable<RequestInit["body"]>, headers: Record<string, string> = {}) =>
    handleManagement(new Request(`${ORIGIN}${MANAGEMENT_PREFIX}/${path}`, { method, headers, ...(body === undefined ? {} : { body }) }), account);
  return { vault, account, call };
}

function saveLogin(vault: Vault, name: string, email = "me@example.com"): void {
  vault.saveCredentialFile(name, "claude", claudeFileData({ accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: NOW + 3600, email }), NOW);
}

describe("config", () => {
  it("reads the whole tree, one path, and the raw YAML with the same ETag", async () => {
    const { call } = setup();
    const tree = await call("GET", "config");
    expect(tree.headers.get("x-cpa-version")).toBe("sub2api-free");
    expect(await tree.json()).toMatchObject({ "config-version": 8, access: { "api-keys": [] } });
    expect(await (await call("GET", "config/routing/strategy")).json()).toBe("round-robin");
    expect((await call("GET", "config/nope")).status).toBe(404);
    const yaml = await call("GET", "config.yaml");
    const text = await yaml.text();
    expect(parse(text)).toMatchObject({ "config-version": 8 });
    expect(yaml.headers.get("etag")).toBe(await configTag(text));
    expect(tree.headers.get("etag")).toBe(yaml.headers.get("etag"));
  });

  it("replaces, merges and deletes, keeping comments elsewhere", async () => {
    const { call, account } = setup();
    expect((await call("PUT", "config.yaml", "# mine\nrouting:\n  strategy: fill-first\nextra:\n  a: 1\n  b: 2\n")).status).toBe(200);
    expect(await (await call("PUT", "config/access/api-keys", '["k1","k2"]')).json()).toEqual({ status: "ok", "config-version": 8 });
    await call("PATCH", "config/extra", '{"b":3,"c":{"d":null}}');
    expect(await (await call("GET", "config/extra")).json()).toEqual({ a: 1, b: 3, c: { d: null } });
    await call("DELETE", "config/extra/c/d");
    expect(await (await call("GET", "config/extra")).json()).toEqual({ a: 1, b: 3 });
    expect(account.currentConfig().apiKeys()).toEqual(["k1", "k2"]);
    expect(account.currentConfig().text).toContain("# mine");
  });

  it("refuses bad writes and stale ETags", async () => {
    const { call } = setup();
    expect((await call("PUT", "config/access/api-keys", "[1]")).status).toBe(400);
    expect((await call("PUT", "config", "[]")).status).toBe(400);
    expect((await call("PUT", "config.yaml", "- a list")).status).toBe(400);
    expect((await call("PATCH", "config", "not json")).status).toBe(400);
    expect((await call("DELETE", "config")).status).toBe(400);
    expect((await call("DELETE", "config/missing")).status).toBe(404);
    expect((await call("PATCH", "config/routing", '{"strategy":"x"}', { "if-match": '"stale"' })).status).toBe(412);
    const tag = (await call("GET", "config")).headers.get("etag") ?? "";
    expect((await call("PATCH", "config/routing", '{"strategy":"x"}', { "if-match": tag })).status).toBe(200);
  });
});

describe("credentials", () => {
  it("lists logins in CPA's auth-file shape, with paging", async () => {
    const { call, vault } = setup();
    saveLogin(vault, "claude-a.json", "a@example.com");
    saveLogin(vault, "claude-b.json", "b@example.com");
    const list = (await (await call("GET", "credentials")).json()) as { files: Record<string, unknown>[] };
    expect(list.files).toHaveLength(2);
    expect(list.files[0]).toMatchObject({ name: "claude-a.json", type: "claude", email: "a@example.com", status: "active", disabled: false });
    expect(await (await call("GET", "credentials?page=2&page_size=1")).json()).toMatchObject({ total: 2, page: 2, has_more: false, files: [{ name: "claude-b.json" }] });
  });

  it("uploads auth files as a form or raw JSON", async () => {
    const { call, vault } = setup();
    const form = new FormData();
    form.append("file", new File(['{"type":"claude","access_token":"x"}'], "claude-up.json"));
    form.append("file", new File(["nope"], "bad.txt"));
    const response = await call("POST", "credentials", form);
    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({ status: "partial", files: ["claude-up.json"], failed: [{ name: "bad.txt" }] });
    expect((await call("POST", "credentials?name=codex-x.json", '{"type":"codex"}')).status).toBe(200);
    expect(vault.credentialFiles().map((file) => [file.name, file.provider])).toEqual([
      ["claude-up.json", "claude"],
      ["codex-x.json", "codex"],
    ]);
    expect((await call("POST", "credentials?name=x.json", "{}")).status).toBe(400);
  });

  it("downloads, disables, edits fields and deletes", async () => {
    const { call, vault } = setup();
    saveLogin(vault, "claude-a.json");
    saveLogin(vault, "claude-b.json");
    const download = await call("GET", "credentials/download?name=claude-a.json");
    expect(download.headers.get("content-disposition")).toContain("claude-a.json");
    expect(await download.json()).toMatchObject({ type: "claude", access_token: "at-claude-a.json" });
    await call("PATCH", "credentials/status", '{"name":"claude-a.json","disabled":true}');
    expect(vault.credentialFile("claude-a.json")?.disabled).toBe(true);
    await call("PATCH", "credentials/fields", '{"name":"claude-a.json","note":"work","email":null}');
    expect(vault.credentialFile("claude-a.json")?.data).toMatchObject({ note: "work" });
    expect(vault.credentialFile("claude-a.json")?.data.email).toBeUndefined();
    expect((await call("DELETE", "credentials?name=missing.json")).status).toBe(404);
    expect((await call("DELETE", "credentials", '{"names":["claude-a.json"]}')).status).toBe(200);
    expect(await (await call("DELETE", "credentials?all=true")).json()).toEqual({ status: "ok", deleted: 1 });
  });
});

describe("OAuth", () => {
  it("runs CPA's auth-url, callback and status flow", async () => {
    const fetcher: Fetcher = async (request) => {
      expect(request.url).toBe(TOKEN_URL);
      return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, account: { email_address: "me@example.com" } });
    };
    const { call, vault } = setup(fetcher);
    expect((await call("GET", "oauth/auth-url?provider=gemini")).status).toBe(404);
    const started = (await (await call("GET", "oauth/auth-url?provider=anthropic")).json()) as { url: string; state: string };
    expect(started.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
    expect(await (await call("GET", `oauth/status?state=${started.state}`)).json()).toEqual({ status: "wait" });
    const redirect = `http://localhost:54545/callback?code=c&state=${started.state}`;
    expect(await (await call("POST", "oauth/callback", JSON.stringify({ redirect_url: redirect }))).json()).toEqual({ status: "ok" });
    expect(await (await call("GET", `oauth/status?state=${started.state}`)).json()).toEqual({ status: "ok" });
    expect(vault.credentialFile("claude-me@example.com.json")).not.toBeNull();
    expect((await call("GET", "oauth/callback?code=c")).status).toBe(400);
  });

  it("cancels a session", async () => {
    const { call } = setup();
    const { state } = (await (await call("POST", "oauth/auth-url", '{"provider":"claude"}')).json()) as { state: string };
    expect(await (await call("DELETE", `oauth/session?state=${state}`)).json()).toEqual({ status: "ok", cancelled: true });
    expect(await (await call("GET", `oauth/status?state=${state}`)).json()).toMatchObject({ status: "error" });
  });
});

describe("pages the free install doesn't have", () => {
  it("answers with empty data instead of errors", async () => {
    const { call } = setup();
    expect(await (await call("GET", "plugins")).json()).toMatchObject({ plugins_enabled: false, plugins: [] });
    expect(await (await call("GET", "observability/usage/queue")).json()).toEqual([]);
    expect((await call("GET", "observability/logs")).status).toBe(400);
    expect((await call("GET", "nothing/here")).status).toBe(404);
  });
});

describe("model lists", () => {
  it("lists each login's models and the catalog by channel", async () => {
    const { call, vault } = setup();
    saveLogin(vault, "claude-me@example.com.json");
    vault.saveCredentialFile("codex-me-free.json", "codex", { type: "codex", access_token: "at", refresh_token: "rt", plan_type: "free" }, NOW);
    const claude = (await (await call("GET", "credentials/models?name=claude-me%40example.com.json")).json()) as { models: { id: string; owned_by: string }[] };
    expect(claude.models.length).toBeGreaterThan(0);
    expect(claude.models.every((model) => model.id.startsWith("claude-") && model.owned_by === "anthropic")).toBe(true);
    const codex = (await (await call("GET", "credentials/models?name=codex-me-free.json")).json()) as { models: { id: string }[] };
    expect(codex.models.map((model) => model.id)).not.toContain("gpt-6-astra");
    expect(codex.models.map((model) => model.id)).toContain("gpt-6-luna");
    vault.setCredentialStatus("codex-me-free.json", true, "", NOW);
    expect(await (await call("GET", "credentials/models?name=codex-me-free.json")).json()).toEqual({ models: [] });
    expect((await call("GET", "credentials/models?name=missing.json")).status).toBe(404);

    const definitions = (await (await call("GET", "routing/model-definitions/Codex")).json()) as { channel: string; models: { id: string; object: string }[] };
    expect(definitions.channel).toBe("codex");
    expect(definitions.models.map((model) => model.id)).toContain("gpt-6-astra");
    expect(definitions.models[0]?.object).toBe("model");
    expect((await (await call("GET", "routing/model-definitions/gemini")).json()) as { models: unknown[] }).toMatchObject({ channel: "gemini" });
    const unknown = await call("GET", "routing/model-definitions/kimi");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "unknown channel", channel: "kimi" });
  });
});
