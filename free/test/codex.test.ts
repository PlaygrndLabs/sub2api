import { describe, expect, it } from "vitest";
import { Account } from "../src/account.ts";
import type { Fetcher } from "../src/claude-oauth.ts";
import { CLIENT_ID, REDIRECT_URI, TOKEN_URL, codexCredential, codexFileData, codexFileName, idTokenClaims } from "../src/codex-oauth.ts";
import { handleManagement, MANAGEMENT_PREFIX } from "../src/management.ts";
import { Vault } from "../src/vault.ts";
import { memorySql } from "./sqlite.ts";

const NOW = 1_800_000_000;

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const ID_TOKEN = idToken({ email: "me@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "Pro" } });

function setup(responses: Response[] = []) {
  const vault = new Vault(memorySql());
  const bodies: URLSearchParams[] = [];
  const fetcher: Fetcher = async (request) => {
    expect(request.url).toBe(TOKEN_URL);
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    bodies.push(new URLSearchParams(await request.text()));
    return responses.shift() ?? new Response("no more", { status: 500 });
  };
  return { vault, bodies, account: new Account(vault, fetcher, () => NOW) };
}

function tokens(access: string, refresh?: string): Response {
  return Response.json({ access_token: access, ...(refresh === undefined ? {} : { refresh_token: refresh }), id_token: ID_TOKEN, expires_in: 3600 });
}

describe("ChatGPT (Codex) login", () => {
  it("reads the account, email and plan from the ID token", () => {
    expect(idTokenClaims(ID_TOKEN)).toEqual({ accountId: "acct-123", email: "me@example.com", planType: "Pro" });
    expect(idTokenClaims("not-a-jwt")).toEqual({ accountId: "", email: "", planType: "free" });
    expect(idTokenClaims("a.!!!.c")).toEqual({ accountId: "", email: "", planType: "free" });
  });

  it("signs in with PKCE and saves CPA's codex auth file", async () => {
    const { account, bodies, vault } = setup([tokens("at-1", "rt-1")]);
    const { url, state } = await account.startLogin("codex");
    const link = new URL(url);
    expect(link.origin + link.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(link.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(link.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
    expect(link.searchParams.get("state")).toBe(state);

    expect(await account.finishLogin(state, "the-code", "")).toEqual({ status: 200 });
    expect(Object.fromEntries(bodies[0] ?? [])).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI });
    expect(bodies[0]?.get("code_verifier")).toMatch(/^[\w-]{100,}$/);
    const [file] = vault.credentialFiles();
    expect(file?.name).toMatch(/^codex-[0-9a-f]{8}-me@example\.com-pro\.json$/);
    expect(file?.provider).toBe("codex");
    expect(file?.data).toMatchObject({ type: "codex", access_token: "at-1", refresh_token: "rt-1", account_id: "acct-123", email: "me@example.com", plan_type: "Pro" });
    expect(await account.routing()).toMatchObject({ claudeOAuth: false, codexOAuth: true });
  });

  it("hands out the token with its account, and refreshes it near expiry keeping the refresh token", async () => {
    const { account, bodies, vault } = setup([tokens("at-2")]);
    const near = codexFileData({ accessToken: "at-1", refreshToken: "rt-1", idToken: ID_TOKEN, accountId: "acct-123", email: "me@example.com", planType: "pro", expiresAt: NOW + 60 });
    vault.saveCredentialFile("codex-me.json", "codex", near, NOW);
    expect(await account.codexToken()).toEqual({ ok: true, accessToken: "at-2", expiresAt: NOW + 3600, accountId: "acct-123" });
    expect(Object.fromEntries(bodies[0] ?? [])).toEqual({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "rt-1", scope: "openid profile email" });
    expect(vault.credentialFile("codex-me.json")?.data).toMatchObject({ access_token: "at-2", refresh_token: "rt-1" });
    // A Claude-only gateway still says to connect a ChatGPT account.
    expect(await setup().account.codexToken()).toMatchObject({ ok: false, message: expect.stringMatching(/ChatGPT/) });
  });

  it("takes an uploaded CPA file without account_id, and names files without one", async () => {
    expect(codexCredential({ access_token: "a", refresh_token: "r", id_token: ID_TOKEN })?.accountId).toBe("acct-123");
    expect(codexCredential({ access_token: "a" })).toBeNull();
    expect(await codexFileName({ accessToken: "a", refreshToken: "r", idToken: "", accountId: "", email: "", planType: "free", expiresAt: 0 })).toBe("codex-account-free.json");
  });

  it("starts from the dashboard under CPA's provider names", async () => {
    const { account } = setup();
    const call = (path: string) => handleManagement(new Request(`https://gateway.example${MANAGEMENT_PREFIX}/${path}`), account);
    for (const provider of ["codex", "openai"]) {
      const started = (await (await call(`oauth/auth-url?provider=${provider}`)).json()) as { url: string };
      expect(started.url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    }
    expect((await call("oauth/auth-url?provider=__proto__")).status).toBe(404);
  });
});
