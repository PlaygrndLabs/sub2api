import { describe, expect, it } from "vitest";
import { CONFIG_KEY, IMPORT_KEY, importBody, takeImport } from "../src/import-config.ts";
import exporter from "../scripts/move-to-container/export.ts";

const TOKEN = "move-token-0123456789abcdef0123456789abcdef";
const CLIENT_KEY = "client-key-0123456789abcdef0123456789abcdef";
const WORKER_CONFIG = `config-version: 8
access:
  api-keys:
    - ${CLIENT_KEY}
routing:
  strategy: fill-first
claude-api-key:
  - api-key: sk-ant-provider-key
`;

class Bucket {
  readonly objects = new Map<string, string>();
  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }
  async get(key: string) {
    const text = this.objects.get(key);
    return text === undefined ? null : { text: async () => text };
  }
  async put(key: string, value: string) {
    this.objects.set(key, value);
    return { key };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

describe("first-boot import", () => {
  it("drops the sections the entrypoint writes", () => {
    const body = importBody(`${WORKER_CONFIG}server:\n  port: 1\nmanagement:\n  secret-key: x\nremote-management:\n  secret-key: y\n`);
    expect(body).toContain(CLIENT_KEY);
    expect(body).toContain("fill-first");
    expect(body).not.toMatch(/config-version|server|management|secret-key/);
  });

  it("imports nothing from a file that is not a map", () => {
    expect(importBody("- a\n- b\n")).toBeNull();
    expect(importBody("config-version: 8\n")).toBeNull();
    expect(importBody("a: [\n")).toBeNull();
  });

  it("hands the waiting config to CPA's first start only", async () => {
    const bucket = new Bucket();
    expect(await takeImport(bucket)).toBeNull();
    bucket.objects.set(IMPORT_KEY, WORKER_CONFIG);
    expect(await takeImport(bucket)).toContain(CLIENT_KEY);
    expect(bucket.objects.has(IMPORT_KEY)).toBe(true);
    bucket.objects.set(CONFIG_KEY, "config-version: 8\n");
    expect(await takeImport(bucket)).toBeNull();
    expect(bucket.objects.has(IMPORT_KEY)).toBe(false);
  });
});

interface FakeFile {
  readonly name: string;
  readonly disabled: boolean;
  readonly data: Record<string, unknown>;
}

function fakeStore(files: FakeFile[]) {
  return {
    async manage(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname.replace("/v8/management/", "");
      if (path === "config.yaml") return new Response(WORKER_CONFIG);
      if (path === "credentials") return Response.json({ files: files.map(({ name, disabled }) => ({ name, disabled })) });
      if (path === "credentials/download") {
        const file = files.find((entry) => entry.name === url.searchParams.get("name"));
        return file === undefined ? Response.json({ error: "auth file not found" }, { status: 404 }) : Response.json(file.data);
      }
      if (path === "observability/logs") return Response.json({ lines: ["one"] });
      return Response.json({ error: "logging to file disabled" }, { status: 400 });
    },
  };
}

function env(bucket: Bucket, files: FakeFile[], token: string | null = TOKEN) {
  const store = fakeStore(files);
  return {
    STORE: { idFromName: (name: string) => name, get: () => store },
    STATE: bucket,
    ...(token === null ? {} : { MOVE_TOKEN: token }),
  } as unknown as Parameters<typeof exporter.fetch>[1];
}

function call(environment: Parameters<typeof exporter.fetch>[1], token = TOKEN): Promise<Response> {
  const request = new Request("https://sub2api-move.example.workers.dev/export", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  return exporter.fetch(request as Parameters<typeof exporter.fetch>[0], environment) as Promise<Response>;
}

const FILES: FakeFile[] = [
  { name: "codex-user@example.com.json", disabled: false, data: { type: "codex", access_token: "at-secret", refresh_token: "rt-secret" } },
  { name: "claude-user@example.com.json", disabled: true, data: { type: "claude", access_token: "at-2", refresh_token: "rt-2" } },
];

describe("export from the Workers-only install", () => {
  it("refuses a missing, short or wrong token", async () => {
    expect((await call(env(new Bucket(), FILES, null))).status).toBe(401);
    expect((await call(env(new Bucket(), FILES, "short"), "short")).status).toBe(401);
    expect((await call(env(new Bucket(), FILES), "wrong-token-0123456789abcdef0123456789abcdef")).status).toBe(401);
  });

  it("backs up everything and puts config and logins where CPA reads them", async () => {
    const bucket = new Bucket();
    const response = await call(env(bucket, FILES));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/secret|client-key|sk-ant/);
    const result = JSON.parse(text) as Record<string, unknown>;
    expect(result).toMatchObject({ gateway_api_keys: 1, auth_files: 2, auth_files_moved: 2, auth_files_disabled: 1 });
    expect(bucket.objects.get(IMPORT_KEY)).toBe(WORKER_CONFIG);
    const backup = String(result.backup);
    expect(bucket.objects.get(`${backup}config.yaml`)).toBe(WORKER_CONFIG);
    expect(bucket.objects.has(`${backup}credentials.json`)).toBe(true);
    expect(bucket.objects.has(`${backup}logs.json`)).toBe(true);
    expect(bucket.objects.has(`${backup}api-key-usage.json`)).toBe(false);
    expect(JSON.parse(bucket.objects.get(`${backup}auths/codex-user@example.com.json`) ?? "")).toEqual(FILES[0]?.data);
    expect(JSON.parse(bucket.objects.get("auths/codex-user@example.com.json") ?? "")).toEqual(FILES[0]?.data);
    expect(JSON.parse(bucket.objects.get("auths/claude-user@example.com.json") ?? "")).toMatchObject({ type: "claude", disabled: true });
  });

  it("leaves a running Container install's config and logins alone", async () => {
    const bucket = new Bucket();
    bucket.objects.set(CONFIG_KEY, "config-version: 8\n");
    bucket.objects.set("auths/codex-user@example.com.json", '{"type":"codex","access_token":"newer"}');
    const result = (await (await call(env(bucket, FILES))).json()) as Record<string, unknown>;
    expect(result).toMatchObject({ auth_files_moved: 1, auth_files_already_there: 1 });
    expect(bucket.objects.has(IMPORT_KEY)).toBe(false);
    expect(bucket.objects.get("auths/codex-user@example.com.json")).toContain("newer");
  });

  it("stops on a file name CPA can't store", async () => {
    const bucket = new Bucket();
    const response = await call(env(bucket, [{ name: "../config.json", disabled: false, data: { type: "codex" } }]));
    expect(response.status).toBe(500);
    expect([...bucket.objects.keys()].some((key) => key.startsWith("auths/"))).toBe(false);
    expect(bucket.objects.has(IMPORT_KEY)).toBe(false);
  });
});
