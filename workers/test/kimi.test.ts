import { describe, expect, it } from "vitest";
import { Account } from "../src/account.ts";
import type { Fetcher } from "../src/claude-oauth.ts";
import { CLIENT_ID, kimiLogin, kimiUpstreamModel } from "../src/kimi-oauth.ts";
import { handleManagement, MANAGEMENT_PREFIX } from "../src/management.ts";
import { Vault } from "../src/vault.ts";
import { memorySql } from "./sqlite.ts";

const NOW = 1_800_000_000;

interface Sent {
  readonly url: string;
  readonly form: URLSearchParams;
  readonly headers: Headers;
}

function kimiServer(answers: Response[]): { fetcher: Fetcher; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetcher: async (request) => {
      sent.push({ url: request.url, form: new URLSearchParams(await request.text()), headers: request.headers });
      return answers.shift() ?? new Response("no more", { status: 500 });
    },
  };
}

const device = () => Response.json({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri_complete: "https://www.kimi.com/code/authorize?user_code=ABCD-1234", interval: 5, expires_in: 900 });
const pending = () => Response.json({ error: "authorization_pending" });
const tokens = (access: string, refresh = "rt-1") => Response.json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: "kimi-code" });

function setup(answers: Response[]) {
  const vault = new Vault(memorySql());
  let now = NOW;
  const server = kimiServer(answers);
  const account = new Account(vault, server.fetcher, () => now);
  const call = async (method: string, path: string) => (await handleManagement(new Request(`https://gateway.example${MANAGEMENT_PREFIX}/${path}`, { method }), account)).json() as Promise<Record<string, unknown>>;
  return { vault, account, call, ...server, advance: (seconds: number) => (now += seconds) };
}

describe("Kimi logins", () => {
  it("runs CPA's device flow: the dashboard gets Kimi's page, and polling the status finishes it", async () => {
    const { call, sent, advance, account, vault } = setup([device(), pending(), tokens("at-1")]);
    const started = await call("GET", "oauth/auth-url?provider=kimi");
    expect(started).toMatchObject({ status: "ok", url: "https://www.kimi.com/code/authorize?user_code=ABCD-1234", flow: "device", user_code: "ABCD-1234", expires_in: 900 });
    expect(sent[0]?.url).toBe("https://auth.kimi.com/api/oauth/device_authorization");
    expect(sent[0]?.form.get("client_id")).toBe(CLIENT_ID);
    expect(sent[0]?.headers.get("x-msh-platform")).toBe("sub2api");
    const deviceId = sent[0]?.headers.get("x-msh-device-id");
    const state = String(started.state);
    expect(await call("GET", `oauth/status?state=${state}`)).toEqual({ status: "wait" });
    // Polled again too soon: Kimi isn't asked.
    expect(await call("GET", `oauth/status?state=${state}`)).toEqual({ status: "wait" });
    expect(sent).toHaveLength(2);
    advance(5);
    expect(await call("GET", `oauth/status?state=${state}`)).toEqual({ status: "ok" });
    expect(sent[2]?.url).toBe("https://auth.kimi.com/api/oauth/token");
    expect(Object.fromEntries(sent[2]?.form ?? [])).toEqual({ client_id: CLIENT_ID, device_code: "dev-1", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    const [file] = vault.credentialFiles();
    expect(file?.provider).toBe("kimi");
    expect(file?.data).toMatchObject({ type: "kimi", access_token: "at-1", refresh_token: "rt-1", domain: "kimi.com", base_url: "https://api.kimi.com/coding", device_id: deviceId });
    expect((await account.routing()).kimiOAuth).toBe(true);
    expect(await account.loginToken("kimi")).toMatchObject({ ok: true, accessToken: "at-1", endpoint: "https://api.kimi.com/coding", headers: { "x-msh-device-id": deviceId, "x-msh-platform": "sub2api" } });
  });

  it("signs in on kimi.ai too, and reports a refused login", async () => {
    const { call, sent, advance, vault } = setup([device(), tokens("at-ai"), device(), Response.json({ error: "access_denied" })]);
    const first = await call("GET", "oauth/auth-url?provider=kimi-ai");
    expect(sent[0]?.url).toBe("https://auth.kimi.ai/api/oauth/device_authorization");
    expect(await call("GET", `oauth/status?state=${String(first.state)}`)).toEqual({ status: "ok" });
    expect(vault.credentialFiles()[0]).toMatchObject({ provider: "kimi-ai", data: { type: "kimi-ai", base_url: "https://api.kimi.ai/coding" } });
    advance(1);
    const second = await call("POST", "oauth/auth-url?provider=kimi");
    expect(await call("GET", `oauth/status?state=${String(second.state)}`)).toEqual({ status: "error", error: "Authentication failed: access denied" });
    expect(await call("POST", `oauth/callback?state=${String(second.state)}&code=x`)).toMatchObject({ status: "error" });
  });

  it("refreshes an expiring login, and marks one Kimi refuses", async () => {
    const { vault, account, sent } = setup([tokens("at-2", "rt-2"), new Response("no", { status: 401 })]);
    vault.saveCredentialFile("kimi-1.json", "kimi", { type: "kimi", access_token: "at-1", refresh_token: "rt-1", device_id: "dev-x", domain: "kimi.com", expired: new Date((NOW + 60) * 1000).toISOString() }, NOW);
    expect(await account.loginToken("kimi")).toMatchObject({ ok: true, accessToken: "at-2" });
    expect(Object.fromEntries(sent[0]?.form ?? [])).toEqual({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "rt-1" });
    expect(vault.credentialFile("kimi-1.json")?.data).toMatchObject({ access_token: "at-2", refresh_token: "rt-2", device_id: "dev-x" });
    const file = vault.credentialFile("kimi-1.json");
    if (file === null) throw new Error("login file missing");
    const forced = await account.tokenFor(file, true);
    expect(forced).toMatchObject({ ok: false, status: 503 });
    expect(vault.credentialFile("kimi-1.json")?.statusMessage).toBe("token expired");
  });

  it("sends tokens only to Kimi's own API, whatever base_url a file names", () => {
    expect(kimiLogin({ type: "kimi", access_token: "a", refresh_token: "r", base_url: "https://evil.example" })).toMatchObject({ domain: "kimi.com" });
    expect(kimiLogin({ type: "kimi-ai", access_token: "a", refresh_token: "r" })).toMatchObject({ domain: "kimi.ai" });
    expect(kimiLogin({ type: "kimi" })).toBeNull();
  });

  it("maps model names as CPA does", () => {
    expect(kimiUpstreamModel("kimi-k3")).toBe("k3");
    expect(kimiUpstreamModel("kimi-k2.8[1m]")).toBe("kimi-for-coding");
    expect(kimiUpstreamModel("kimi-k2.7-code-highspeed")).toBe("kimi-for-coding-highspeed");
    expect(kimiUpstreamModel("kimi-k3[1m](1024)")).toBe("k3(1024)");
  });
});
