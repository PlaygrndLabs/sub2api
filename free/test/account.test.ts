import { describe, expect, it } from "vitest";
import { Account, hashKey } from "../src/account.ts";
import { CLIENT_ID, REDIRECT_URI, TOKEN_URL, parseCallback, type Fetcher } from "../src/claude-oauth.ts";
import { Config } from "../src/config.ts";
import { Vault, claudeFileData } from "../src/vault.ts";
import { memorySql } from "./sqlite.ts";

const NOW = 1_800_000_000;

function tokenEndpoint(responses: Response[]): { fetcher: Fetcher; bodies: Record<string, string>[] } {
  const bodies: Record<string, string>[] = [];
  return {
    bodies,
    fetcher: async (request) => {
      expect(request.url).toBe(TOKEN_URL);
      bodies.push((await request.json()) as Record<string, string>);
      return responses.shift() ?? new Response("no more", { status: 500 });
    },
  };
}

function tokens(access: string, refresh: string, expiresIn = 28800): Response {
  return Response.json({ access_token: access, refresh_token: refresh, expires_in: expiresIn, account: { email_address: "me@example.com" } });
}

function setup(responses: Response[] = [], now = () => NOW) {
  const sql = memorySql();
  const vault = new Vault(sql);
  const endpoint = tokenEndpoint(responses);
  return { sql, vault, ...endpoint, account: new Account(vault, endpoint.fetcher, now) };
}

function saveLogin(vault: Vault, name: string, accessToken: string, expiresAt: number, email = "me@example.com"): void {
  vault.saveCredentialFile(name, "claude", claudeFileData({ accessToken, refreshToken: `rt-${accessToken}`, expiresAt, email }), NOW);
}

describe("parseCallback", () => {
  it("reads the localhost address", () => {
    expect(parseCallback(" http://localhost:54545/callback?code=abc&state=xyz ")).toEqual({ code: "abc", state: "xyz" });
  });
  it("reads code#state text", () => {
    expect(parseCallback("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
  });
  it.each(["", "abc", "http://localhost:54545/callback?code=abc", "http://[bad"])("rejects %j", (text) => {
    expect(parseCallback(text)).toBeNull();
  });
});

describe("Claude login", () => {
  it("builds a PKCE authorize link and saves the login as a CPA credential file", async () => {
    const { account, bodies, vault } = setup([tokens("at-1", "rt-1")]);
    const { url, state } = await account.startLogin("claude");
    const link = new URL(url);
    expect(link.origin + link.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(link.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(link.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(link.searchParams.get("state")).toBe(state);
    expect(account.session(state)?.status).toBe("wait");

    expect(await account.finishLogin(state, "the-code#ignored", "")).toEqual({ status: 200 });
    expect(bodies[0]).toMatchObject({ grant_type: "authorization_code", code: "the-code", state, client_id: CLIENT_ID });
    expect(account.session(state)?.status).toBe("ok");
    const [file] = vault.credentialFiles();
    expect(file).toMatchObject({ name: "claude-me@example.com.json", provider: "claude", disabled: false });
    expect(file?.data).toMatchObject({ type: "claude", access_token: "at-1", refresh_token: "rt-1", email: "me@example.com" });

    expect(await account.finishLogin(state, "again", "")).toEqual({ status: 409, error: "oauth flow is already completed" });
  });

  it("keeps the session across a restart of the Durable Object", async () => {
    const first = setup([tokens("at-1", "rt-1")]);
    const { state } = await first.account.startLogin("claude");
    const restarted = new Account(new Vault(first.sql), first.fetcher, () => NOW + 60);
    expect((await restarted.finishLogin(state, "code", "")).status).toBe(200);
    expect(restarted.session(state)?.status).toBe("ok");
  });

  it("reports unknown states, provider errors and a failed exchange", async () => {
    const { account } = setup([new Response("invalid_grant", { status: 400 })]);
    expect(await account.finishLogin("nope", "code", "")).toEqual({ status: 404, error: "unknown or expired state" });
    const denied = await account.startLogin("claude");
    await account.finishLogin(denied.state, "", "access_denied");
    expect(account.session(denied.state)).toMatchObject({ status: "error", error: "Bad request" });
    const failed = await account.startLogin("claude");
    await account.finishLogin(failed.state, "code", "");
    expect(account.session(failed.state)?.error).toMatch(/Anthropic answered 400: invalid_grant/);
  });

  it("finishes a login from pasted text", async () => {
    const { account } = setup([tokens("at-1", "rt-1")]);
    const { state } = await account.startLogin("claude");
    expect(await account.finishLoginFromText("garbage")).toMatch(/callback address/);
    expect(await account.finishLoginFromText(`${REDIRECT_URI}?code=c&state=${state}`)).toBeNull();
  });
});

describe("access token", () => {
  it("says to connect when there is no login", async () => {
    const { account } = setup();
    expect(await account.token()).toMatchObject({ ok: false, status: 503 });
  });

  it("serves a fresh token without calling Anthropic, and skips disabled logins", async () => {
    const { account, vault, bodies } = setup();
    saveLogin(vault, "claude-a.json", "at-a", NOW + 3600);
    saveLogin(vault, "claude-b.json", "at-b", NOW + 3600);
    vault.setCredentialStatus("claude-b.json", true, "", NOW);
    expect(await account.token()).toEqual({ ok: true, accessToken: "at-a", expiresAt: NOW + 3600 });
    expect(await account.token()).toMatchObject({ accessToken: "at-a" });
    expect(bodies).toHaveLength(0);
  });

  it("takes turns between logins", async () => {
    const { account, vault } = setup();
    saveLogin(vault, "claude-a.json", "at-a", NOW + 3600);
    saveLogin(vault, "claude-b.json", "at-b", NOW + 3600);
    const tokensSeen = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const result = await account.token();
      tokensSeen.push(result.ok ? result.accessToken : "");
    }
    expect(tokensSeen).toEqual(["at-a", "at-b", "at-a", "at-b"]);
  });

  it("refreshes near expiry once, however many requests ask", async () => {
    const { account, vault, bodies } = setup([tokens("at-2", "", 3600)]);
    saveLogin(vault, "claude-a.json", "at-1", NOW + 60);
    const file = vault.credentialFile("claude-a.json");
    if (file === null) throw new Error("missing");
    const results = await Promise.all([account.tokenFor(file), account.tokenFor(file), account.tokenFor(file)]);
    expect(results.every((result) => result.ok && result.accessToken === "at-2")).toBe(true);
    expect(bodies).toEqual([{ grant_type: "refresh_token", refresh_token: "rt-at-1", client_id: CLIENT_ID, scope: expect.any(String) }]);
    expect(vault.credentialFile("claude-a.json")?.data).toMatchObject({ access_token: "at-2", refresh_token: "rt-at-1", email: "me@example.com" });
  });

  it("keeps using an unexpired token when a refresh fails, and flags a dead login", async () => {
    const { account, vault } = setup([new Response("busy", { status: 503 }), new Response("bad", { status: 400 })]);
    saveLogin(vault, "claude-a.json", "at", NOW + 60);
    expect(await account.token()).toMatchObject({ ok: true, accessToken: "at" });
    expect(await account.token()).toMatchObject({ ok: false, message: expect.stringMatching(/sign in again/) });
    expect(vault.credentialFile("claude-a.json")?.statusMessage).toBe("token expired");
  });

  it("forces a refresh after Anthropic refuses the token, at most once a minute", async () => {
    let now = NOW;
    const { account, vault } = setup([tokens("at-2", "rt-2"), tokens("at-3", "rt-3")], () => now);
    saveLogin(vault, "claude-a.json", "at-1", NOW + 3600);
    await account.invalidate("someone-else");
    expect(await account.token()).toMatchObject({ accessToken: "at-1" });
    await account.invalidate("at-1");
    expect(await account.token()).toMatchObject({ accessToken: "at-2" });
    await account.invalidate("at-2");
    expect(await account.token()).toMatchObject({ accessToken: "at-2" });
    now += 61;
    await account.invalidate("at-2");
    expect(await account.token()).toMatchObject({ accessToken: "at-3" });
  });
});

describe("migration from the first free release", () => {
  it("turns the single stored login into a credential file", () => {
    const sql = memorySql();
    new Vault(sql).saveCredential({ accessToken: "at", refreshToken: "rt", expiresAt: NOW + 100, email: "me@example.com" });
    const vault = new Vault(sql);
    expect(vault.credential()).toBeNull();
    expect(vault.credentialFiles()).toHaveLength(1);
    expect(vault.credentialFiles()[0]).toMatchObject({ name: "claude-me@example.com.json", provider: "claude" });
  });
});

describe("API keys and sign-in throttle", () => {
  it("accepts keys from access.api-keys and the old hashed keys", async () => {
    const { account, vault } = setup();
    vault.addKey("old", await hashKey("old-key"), "-key", NOW);
    const config = new Config(account.currentConfig().text);
    config.replace(["access", "api-keys"], ["new-key"]);
    account.saveConfig(config);
    expect(await account.keyValid(await hashKey("new-key"))).toBe(true);
    expect(await account.keyValid(await hashKey("old-key"))).toBe(true);
    expect(await account.keyValid(await hashKey("other"))).toBe(false);
    config.replace(["access", "api-keys"], []);
    account.saveConfig(config);
    expect(await account.keyValid(await hashKey("new-key"))).toBe(false);
  });

  it("allows five sign-in attempts a minute per client", async () => {
    let now = NOW;
    const { account } = setup([], () => now);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await account.attemptAllowed("1.2.3.4")).toBe(true);
    expect(await account.attemptAllowed("1.2.3.4")).toBe(false);
    expect(await account.attemptAllowed("5.6.7.8")).toBe(true);
    now += 60;
    expect(await account.attemptAllowed("1.2.3.4")).toBe(true);
  });
});
