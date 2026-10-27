import { describe, expect, it } from "vitest";
import { Account, hashKey } from "../src/account.ts";
import { CLIENT_ID, REDIRECT_URI, TOKEN_URL, parseCallback, type Fetcher } from "../src/claude-oauth.ts";
import { Vault } from "../src/vault.ts";
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
  const vault = new Vault(memorySql());
  const endpoint = tokenEndpoint(responses);
  return { vault, ...endpoint, account: new Account(vault, endpoint.fetcher, now) };
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
  it("builds a PKCE authorize link and exchanges the code once", async () => {
    const { account, bodies, vault } = setup([tokens("at-1", "rt-1")]);
    const link = new URL(await account.startLogin());
    expect(link.origin + link.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(link.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(link.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
    const state = link.searchParams.get("state") ?? "";

    expect(await account.finishLogin(`${REDIRECT_URI}?code=the-code&state=${state}`)).toBeNull();
    expect(bodies[0]).toMatchObject({ grant_type: "authorization_code", code: "the-code", state, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI });
    expect(bodies[0]?.code_verifier).toMatch(/^[A-Za-z0-9_-]{100,}$/);
    expect(vault.credential()).toEqual({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: NOW + 28800, email: "me@example.com" });

    expect(await account.finishLogin(`${REDIRECT_URI}?code=again&state=${state}`)).toMatch(/expired or was already used/);
  });

  it("refuses an unknown state and reports Anthropic's error", async () => {
    const { account } = setup([new Response("invalid_grant", { status: 400 })]);
    expect(await account.finishLogin("abc#unknown")).toMatch(/expired or was already used/);
    const state = new URL(await account.startLogin()).searchParams.get("state");
    expect(await account.finishLogin(`abc#${state}`)).toMatch(/Anthropic answered 400: invalid_grant/);
  });
});

describe("access token", () => {
  it("says to connect when there is no login", async () => {
    const { account } = setup();
    expect(await account.token()).toMatchObject({ ok: false, status: 503 });
  });

  it("serves a fresh token without calling Anthropic", async () => {
    const { account, vault, bodies } = setup();
    vault.saveCredential({ accessToken: "at", refreshToken: "rt", expiresAt: NOW + 3600, email: "" });
    expect(await account.token()).toEqual({ ok: true, accessToken: "at", expiresAt: NOW + 3600 });
    expect(bodies).toHaveLength(0);
  });

  it("refreshes near expiry once, however many requests ask", async () => {
    const { account, vault, bodies } = setup([tokens("at-2", "", 3600)]);
    vault.saveCredential({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: NOW + 60, email: "me@example.com" });
    const results = await Promise.all([account.token(), account.token(), account.token()]);
    expect(results.every((result) => result.ok && result.accessToken === "at-2")).toBe(true);
    expect(bodies).toEqual([{ grant_type: "refresh_token", refresh_token: "rt-1", client_id: CLIENT_ID, scope: expect.any(String) }]);
    expect(vault.credential()).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1", email: "me@example.com" });
  });

  it("keeps using an unexpired token when a refresh fails, and asks to reconnect on a dead one", async () => {
    const { account, vault } = setup([new Response("busy", { status: 503 }), new Response("bad", { status: 400 })]);
    vault.saveCredential({ accessToken: "at", refreshToken: "rt", expiresAt: NOW + 60, email: "" });
    expect(await account.token()).toMatchObject({ ok: true, accessToken: "at" });
    expect(await account.token()).toMatchObject({ ok: false, message: expect.stringMatching(/connect the account again/) });
  });

  it("forces a refresh after Anthropic refuses the token, at most once a minute", async () => {
    let now = NOW;
    const { account, vault } = setup([tokens("at-2", "rt-2"), tokens("at-3", "rt-3")], () => now);
    vault.saveCredential({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: NOW + 3600, email: "" });
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

describe("API keys and sign-in throttle", () => {
  it("stores only a hash and finds the key by it", async () => {
    const { account, vault } = setup();
    const key = await account.createKey("  laptop  ");
    expect(key).toMatch(/^sk-s2a-[A-Za-z0-9_-]{43}$/);
    expect(await account.keyValid(await hashKey(key))).toBe(true);
    expect(await account.keyValid(await hashKey(`${key}x`))).toBe(false);
    const [row] = vault.keys();
    expect(row).toMatchObject({ name: "laptop", hint: key.slice(-4) });
    await account.revokeKey(row?.id ?? -1);
    expect(await account.keyValid(await hashKey(key))).toBe(false);
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
