import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Account } from "../src/account.ts";
import type { Fetcher } from "../src/claude-oauth.ts";
import { handleManagement, MANAGEMENT_PREFIX } from "../src/management.ts";
import { Vault } from "../src/vault.ts";
import { TOKEN_URL, mintToken, pkcs8Of, serviceAccountOf, vertexFileData, vertexModelsUrl, type ServiceAccount } from "../src/vertex-auth.ts";
import { memorySql } from "./sqlite.ts";

const NOW = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PKCS1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

function keyFile(key = PKCS8): Record<string, unknown> {
  return { type: "service_account", project_id: "proj-1", private_key_id: "kid-1", private_key: key, client_email: "bot@proj-1.iam.gserviceaccount.com", token_uri: "https://evil.example/token" };
}

function serviceAccount(key = PKCS8): ServiceAccount {
  const account = serviceAccountOf(keyFile(key));
  if (account === null) throw new Error("test key file isn't a service account");
  return account;
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

function tokenEndpoint(): { fetcher: Fetcher; assertions: string[] } {
  const assertions: string[] = [];
  return {
    assertions,
    fetcher: async (request) => {
      expect(request.url).toBe(TOKEN_URL);
      const form = new URLSearchParams(await request.text());
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      assertions.push(form.get("assertion") ?? "");
      return Response.json({ access_token: `ya29.${assertions.length}`, expires_in: 3599 });
    },
  };
}

describe("Vertex service accounts", () => {
  it("signs a JWT that Google's token endpoint takes, whatever token_uri the file names", async () => {
    const { fetcher, assertions } = tokenEndpoint();
    expect(await mintToken(fetcher, serviceAccount(), NOW)).toEqual({ accessToken: "ya29.1", expiresAt: NOW + 3599 });
    const [header, claims, signature] = (assertions[0] ?? "").split(".");
    expect(decode(header ?? "")).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    expect(decode(claims ?? "")).toEqual({ iss: "bot@proj-1.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/cloud-platform", aud: TOKEN_URL, iat: NOW, exp: NOW + 3600 });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const verifier = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", verifier, Buffer.from(signature ?? "", "base64url"), new TextEncoder().encode(`${header}.${claims}`));
    expect(valid).toBe(true);
  });

  it("reads PKCS #1 keys, as CPA stores them, and escaped newlines", async () => {
    expect(Buffer.from(pkcs8Of(PKCS1)).equals(privateKey.export({ type: "pkcs8", format: "der" }))).toBe(true);
    const { fetcher } = tokenEndpoint();
    await expect(mintToken(fetcher, serviceAccount(PKCS8.replaceAll("\n", "\\n")), NOW)).resolves.toMatchObject({ accessToken: "ya29.1" });
  });

  it("builds each location's endpoint as CPA does", () => {
    expect(vertexModelsUrl({ projectId: "p", location: "global" })).toBe("https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models");
    expect(vertexModelsUrl({ projectId: "p", location: "eu" })).toBe("https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu/publishers/google/models");
    expect(vertexModelsUrl({ projectId: "p", location: "us-central1" })).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models");
  });

  it("imports a key file from the dashboard, and mints and refreshes its token", async () => {
    const vault = new Vault(memorySql());
    let now = NOW;
    const { fetcher, assertions } = tokenEndpoint();
    const account = new Account(vault, fetcher, () => now);
    const form = new FormData();
    form.append("file", new File([JSON.stringify(keyFile())], "key.json"));
    form.append("location", "europe-west4");
    const imported = await handleManagement(new Request(`https://gateway.example${MANAGEMENT_PREFIX}/oauth/import?provider=vertex`, { method: "POST", body: form }), account);
    expect(await imported.json()).toEqual({ status: "ok", "auth-file": "vertex-proj-1.json", project_id: "proj-1", email: "bot@proj-1.iam.gserviceaccount.com", location: "europe-west4" });
    expect((await account.routing()).vertexOAuth).toBe(true);
    const first = await account.loginToken("vertex");
    expect(first).toEqual({ ok: true, accessToken: "ya29.1", expiresAt: NOW + 3599, name: "vertex-proj-1.json", endpoint: "https://europe-west4-aiplatform.googleapis.com/v1/projects/proj-1/locations/europe-west4/publishers/google/models" });
    expect(await account.loginToken("vertex")).toMatchObject({ accessToken: "ya29.1" });
    now += 3500;
    expect(await account.loginToken("vertex")).toMatchObject({ accessToken: "ya29.2" });
    expect(assertions).toHaveLength(2);
    // Each service account is routed on its own, fetched by name, and only as Vertex.
    expect((await account.routing()).logins).toEqual([{ name: "vertex-proj-1.json", provider: "vertex", priority: 0, weight: 1, prefix: "", disableCooling: null, requestRetry: null }]);
    expect(await account.loginToken("vertex", "vertex-proj-1.json")).toMatchObject({ accessToken: "ya29.2" });
    expect(await account.loginToken("vertex", "other.json")).toMatchObject({ ok: false, status: 503 });
    expect(await account.loginToken("kimi", "vertex-proj-1.json")).toMatchObject({ ok: false, status: 503 });
  });

  it("refuses files that aren't usable service accounts, and odd locations", async () => {
    const account = new Account(new Vault(memorySql()), tokenEndpoint().fetcher, () => NOW);
    const send = async (content: string, location = "") => {
      const form = new FormData();
      form.append("file", new File([content], "key.json"));
      if (location !== "") form.append("location", location);
      const response = await handleManagement(new Request(`https://gateway.example${MANAGEMENT_PREFIX}/oauth/import?provider=vertex`, { method: "POST", body: form }), account);
      return { status: response.status, body: (await response.json()) as { error: string } };
    };
    expect(await send("not json")).toMatchObject({ status: 400, body: { error: "invalid json" } });
    expect(await send(JSON.stringify({ ...keyFile(), private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" }))).toMatchObject({ status: 400, body: { error: "invalid service account" } });
    expect(await send(JSON.stringify({ ...keyFile(), project_id: "" }))).toMatchObject({ status: 400, body: { error: "project_id missing" } });
    expect(await send(JSON.stringify(keyFile()), "evil.example/x")).toMatchObject({ status: 400, body: { error: "invalid location" } });
    expect((await handleManagement(new Request(`https://gateway.example${MANAGEMENT_PREFIX}/oauth/import?provider=claude`, { method: "POST" }), account)).status).toBe(404);
  });

  it("ignores a stored location that would point at another host", () => {
    const data = vertexFileData(keyFile(), "us-central1");
    expect(data).toMatchObject({ type: "vertex", project_id: "proj-1", location: "us-central1", email: "bot@proj-1.iam.gserviceaccount.com" });
    const vault = new Vault(memorySql());
    vault.saveCredentialFile("vertex-x.json", "vertex", { ...data, location: "x.evil.example/" }, NOW);
    return expect(new Account(vault, tokenEndpoint().fetcher, () => NOW).loginToken("vertex")).resolves.toMatchObject({ ok: false, status: 503 });
  });
});
