import { LOGIN_PROVIDERS, type Account, type OAuthProvider } from "./account.ts";
import { OAuthError } from "./claude-oauth.ts";
import { Config, ConfigError, configTag, ifMatchSatisfied } from "./config.ts";
import { codexChannel, definition, definitionChannel, type Catalog } from "./models.ts";
import { apiKeyKey, apiKeyProvider, loginKey, storedKey, type UsageStats } from "./usage.ts";
import type { CredentialFile } from "./vault.ts";
import { serviceAccountOf, signingKey, validLocation, vertexFileData, vertexFileName } from "./vertex-auth.ts";

// CPA's v8 management API (the subset the official dashboard uses), answered from the Durable
// Object. Paths and response shapes follow CPA's handlers so the same dashboard works on both
// installs. The Worker has already checked the dashboard session and the management key.

export const MANAGEMENT_PREFIX = "/v8/management";
export const GATEWAY_VERSION = "sub2api-free";
// CPA's provider names and their aliases.
const OAUTH_ALIASES: Record<string, OAuthProvider> = { claude: "claude", anthropic: "claude", codex: "codex", openai: "codex", kimi: "kimi", "kimi-ai": "kimi" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function failure(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await request.text();
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function configRoute(request: Request, path: string[], yaml: boolean, account: Account): Promise<Response> {
  const config = account.currentConfig();
  const tag = await configTag(config.text);
  if (request.method === "GET") {
    if (yaml) return new Response(config.text, { headers: { "content-type": "application/yaml; charset=utf-8", "cache-control": "no-store", etag: tag } });
    try {
      return json(config.read(path), 200, { etag: tag });
    } catch (error) {
      if (error instanceof ConfigError) return failure(error.status, error.code);
      throw error;
    }
  }
  if (!ifMatchSatisfied(request.headers.get("if-match"), tag)) return failure(412, "precondition_failed");
  const next = new Config(config.text);
  try {
    if (request.method === "DELETE") {
      next.remove(path);
    } else if (yaml) {
      if (request.method !== "PUT") return failure(405, "method_not_allowed");
      next.replaceText(await request.text());
    } else {
      const body = await readJson(request);
      if (!body.ok) return failure(400, "invalid_json");
      if (request.method === "PATCH") next.merge(path, body.value);
      else next.replace(path, body.value);
    }
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.code, message: error.message }, error.status);
    throw error;
  }
  account.saveConfig(next);
  return json({ status: "ok", "config-version": 8 }, 200, { etag: await configTag(next.text) });
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function credentialEntry(file: CredentialFile, nowSeconds: number, usage: UsageStats): Record<string, unknown> {
  const expires = typeof file.data.expired === "string" ? Date.parse(file.data.expired) / 1000 : Number.NaN;
  const expired = Number.isFinite(expires) && expires <= nowSeconds && file.statusMessage === "token expired";
  const entry: Record<string, unknown> = {
    id: file.name,
    auth_index: file.name,
    name: file.name,
    type: file.provider,
    provider: file.provider,
    label: typeof file.data.email === "string" ? file.data.email : file.name,
    status: file.disabled ? "disabled" : expired ? "error" : "active",
    status_message: file.statusMessage,
    disabled: file.disabled,
    unavailable: expired,
    runtime_only: false,
    source: "file",
    path: file.name,
    size: JSON.stringify(file.data).length,
    success: usage.success,
    failed: usage.failed,
    recent_requests: usage.recent_requests,
    quota: null,
    cooldowns: null,
    created_at: iso(file.createdAt),
    modtime: iso(file.updatedAt),
    updated_at: iso(file.updatedAt),
  };
  for (const field of ["email", "project_id", "note", "priority", "prefix", "proxy_url", "last_refresh"]) {
    if (file.data[field] !== undefined && file.data[field] !== "") entry[field] = file.data[field];
  }
  return entry;
}

function listCredentials(url: URL, account: Account): Response {
  const name = url.searchParams.get("name")?.trim() ?? "";
  const files = account.vault.credentialFiles().filter((file) => name === "" || file.name === name);
  const now = account.nowSeconds();
  const entries = files.map((file) => credentialEntry(file, now, account.vault.usage.stats(loginKey(file.name), now)));
  const observedAt = new Date().toISOString();
  if (!url.searchParams.has("page") && !url.searchParams.has("page_size")) return json({ observed_at: observedAt, files: entries });
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.max(1, Number(url.searchParams.get("page_size") ?? "50") || 50);
  const start = (page - 1) * pageSize;
  return json({
    observed_at: observedAt,
    files: entries.slice(start, start + pageSize),
    total: entries.length,
    page,
    page_size: pageSize,
    has_more: start + pageSize < entries.length,
  });
}

// CPA's API-key usage: per provider, keyed "base url|api key", for the keys configured now.
async function apiKeyUsage(account: Account): Promise<Response> {
  const now = account.nowSeconds();
  const out: Record<string, Record<string, UsageStats>> = {};
  for (const credential of (await account.routing()).credentials) {
    const provider = apiKeyProvider(credential);
    const key = `${credential.baseUrl}|${credential.apiKey}`;
    out[provider] ??= {};
    const group = out[provider];
    if (Object.hasOwn(group, key)) continue;
    group[key] = account.vault.usage.stats(await storedKey(apiKeyKey(credential)), now);
  }
  return json(out);
}

// The request log, read like CPA's log file: a tail, lines after a time, or after a cursor.
function logs(url: URL, account: Account): Response {
  if (!account.loggingEnabled()) return failure(400, "logging to file disabled");
  const limitText = url.searchParams.get("limit")?.trim() ?? "";
  const limit = limitText === "" ? 0 : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 0 || (limitText !== "" && limit === 0)) return failure(400, "invalid limit: must be a positive integer");
  const afterText = url.searchParams.get("after")?.trim() ?? "";
  const after = /^\d+$/.test(afterText) ? Number(afterText) : 0;
  const result = account.vault.usage.lines({ cursor: url.searchParams.get("cursor")?.trim() ?? "", after, limit });
  const body: Record<string, unknown> = { lines: result.lines, "line-count": result.lines.length, "latest-timestamp": result.latest, "next-cursor": result.nextCursor };
  if (result.reset) body["cursor-reset"] = true;
  return json(body);
}

function providerOf(name: string, data: Record<string, unknown>): string | null {
  if (typeof data.type === "string" && data.type.trim() !== "") return data.type.trim().toLowerCase();
  const prefix = name.split("-")[0]?.toLowerCase();
  return prefix && prefix !== name.toLowerCase() ? prefix : null;
}

async function uploadCredentials(request: Request, url: URL, account: Account): Promise<Response> {
  const uploads: { name: string; text: string }[] = [];
  if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (form === null) return failure(400, "invalid multipart form");
    for (const value of form.values()) {
      if (typeof value !== "string") uploads.push({ name: value.name, text: await value.text() });
    }
  } else {
    const name = url.searchParams.get("name")?.trim() ?? "";
    if (name === "") return failure(400, "no files uploaded");
    uploads.push({ name, text: await request.text() });
  }
  if (uploads.length === 0) return failure(400, "no files uploaded");
  const uploaded: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const upload of uploads) {
    const name = upload.name.split(/[\\/]/).pop() ?? "";
    if (!name.toLowerCase().endsWith(".json")) {
      failed.push({ name, error: "file must be .json" });
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(upload.text);
    } catch {
      failed.push({ name, error: "invalid json" });
      continue;
    }
    const provider = typeof data === "object" && data !== null && !Array.isArray(data) ? providerOf(name, data as Record<string, unknown>) : null;
    if (provider === null) {
      failed.push({ name, error: "auth file has no type" });
      continue;
    }
    account.vault.saveCredentialFile(name, provider, data as Record<string, unknown>, account.nowSeconds());
    uploaded.push(name);
  }
  if (uploads.length === 1) return failed.length === 0 ? json({ status: "ok" }) : failure(400, failed[0]?.error ?? "upload failed");
  if (failed.length > 0) return json({ status: "partial", uploaded: uploaded.length, files: uploaded, failed }, 207);
  return json({ status: "ok", uploaded: uploaded.length, files: uploaded });
}

async function deleteCredentials(request: Request, url: URL, account: Account): Promise<Response> {
  const all = url.searchParams.get("all");
  if (all === "true" || all === "1" || all === "*") {
    const files = account.vault.credentialFiles();
    for (const file of files) account.vault.removeCredentialFile(file.name);
    return json({ status: "ok", deleted: files.length });
  }
  let names = url.searchParams.getAll("name").map((name) => name.trim()).filter((name) => name !== "");
  if (names.length === 0) {
    const body = await readJson(request);
    if (body.ok) {
      const value = body.value as { name?: unknown; names?: unknown } | unknown[];
      if (Array.isArray(value)) names = value.filter((name): name is string => typeof name === "string");
      else if (typeof value === "object" && value !== null) {
        if (typeof value.name === "string") names.push(value.name);
        if (Array.isArray(value.names)) names.push(...value.names.filter((name): name is string => typeof name === "string"));
      }
    }
  }
  names = [...new Set(names)];
  if (names.length === 0) return failure(400, "invalid name");
  if (names.length === 1) {
    return account.vault.removeCredentialFile(names[0] as string) ? json({ status: "ok" }) : failure(404, "auth file not found");
  }
  const deleted = names.filter((name) => account.vault.removeCredentialFile(name));
  const failed = names.filter((name) => !deleted.includes(name)).map((name) => ({ name, error: "auth file not found" }));
  if (failed.length > 0) return json({ status: "partial", deleted: deleted.length, files: deleted, failed }, 207);
  return json({ status: "ok", deleted: deleted.length, files: deleted });
}

async function patchCredential(request: Request, account: Account, fields: boolean): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok || typeof body.value !== "object" || body.value === null) return failure(400, "invalid request body");
  const value = body.value as Record<string, unknown>;
  const name = typeof value.name === "string" && value.name.trim() !== "" ? value.name.trim() : typeof value.auth_index === "string" ? value.auth_index.trim() : "";
  if (name === "") return failure(400, "name is required");
  const file = account.vault.credentialFile(name);
  if (file === null) return failure(404, "auth file not found");
  if (!fields) {
    if (typeof value.disabled !== "boolean") return failure(400, "disabled is required");
    account.vault.setCredentialStatus(name, value.disabled, value.disabled ? "disabled via management api" : "", account.nowSeconds());
    return json({ status: "ok", disabled: value.disabled });
  }
  const updates = Object.entries(value).filter(([key]) => key !== "name" && key !== "auth_index" && key !== "type");
  const cleared = new Set(updates.filter(([, field]) => field === null).map(([key]) => key));
  const data = Object.fromEntries([...Object.entries(file.data), ...updates].filter(([key]) => !cleared.has(key)));
  account.vault.saveCredentialFile(name, file.provider, data, account.nowSeconds());
  return json({ status: "ok" });
}

// CPA's catalog, refreshed first when a refresh is due.
async function catalogOf(account: Account): Promise<Catalog> {
  await account.catalog.refresh(account.fetcher, account.nowSeconds());
  return account.catalog.current();
}

// The models a login serves, as CPA lists them for its auth file: none while it is disabled.
async function loginModels(file: CredentialFile, account: Account): Promise<Record<string, unknown>[]> {
  if (file.disabled) return [];
  if (file.provider === "claude") return (await catalogOf(account)).claude.map(fileModel);
  if (file.provider === "codex") return (await catalogOf(account))[codexChannel(typeof file.data.plan_type === "string" ? file.data.plan_type : "")].map(fileModel);
  return [];
}

function fileModel(model: { id: string; display_name?: string; type?: string; owned_by?: string }): Record<string, unknown> {
  return { id: model.id, ...(model.display_name === undefined ? {} : { display_name: model.display_name }), ...(model.type === undefined ? {} : { type: model.type }), ...(model.owned_by === undefined ? {} : { owned_by: model.owned_by }) };
}

// Service account key files are a few KB; anything much larger isn't one.
const MAX_SERVICE_ACCOUNT_BYTES = 64 * 1024;

// CPA's Vertex import: a service account key file, stored as a vertex auth file.
async function importVertex(request: Request, url: URL, account: Account): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (file === null || file === undefined || typeof file === "string") return failure(400, "file required");
  if (file.size > MAX_SERVICE_ACCOUNT_BYTES) return failure(400, "invalid service account", { message: "file too large" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return failure(400, "invalid json");
  }
  const serviceAccount = serviceAccountOf(parsed);
  if (serviceAccount === null) return failure(400, "invalid service account", { message: "service account missing client_email or private_key" });
  try {
    await signingKey(serviceAccount);
  } catch (error) {
    return failure(400, "invalid service account", { message: error instanceof OAuthError ? error.message : "private_key can't be read" });
  }
  if (serviceAccount.projectId === "") return failure(400, "project_id missing");
  const formLocation = form?.get("location");
  const location = (typeof formLocation === "string" ? formLocation.trim() : "") || url.searchParams.get("location")?.trim() || "us-central1";
  if (!validLocation(location)) return failure(400, "invalid location");
  const name = vertexFileName(serviceAccount.projectId);
  account.vault.saveCredentialFile(name, "vertex", vertexFileData(parsed as Record<string, unknown>, location), account.nowSeconds());
  return json({ status: "ok", "auth-file": name, project_id: serviceAccount.projectId, email: serviceAccount.clientEmail, location });
}

async function oauthRoute(request: Request, url: URL, action: string, account: Account): Promise<Response> {
  switch (`${request.method} ${action}`) {
    case "GET auth-url":
    case "POST auth-url": {
      let provider = url.searchParams.get("provider")?.trim().toLowerCase() ?? "";
      if (request.method === "POST") {
        const body = await readJson(request);
        const bodyProvider = body.ok && typeof (body.value as { provider?: unknown })?.provider === "string" ? String((body.value as { provider: string }).provider).trim().toLowerCase() : "";
        if (provider !== "" && bodyProvider !== "" && provider !== bodyProvider) return failure(400, "conflicting provider parameter");
        provider ||= bodyProvider;
      }
      if (provider === "") return failure(400, "provider is required");
      const login = Object.hasOwn(OAUTH_ALIASES, provider) ? OAUTH_ALIASES[provider] : undefined;
      if (login === undefined) return failure(404, "provider_not_found");
      if (login !== "kimi") {
        const { url: authUrl, state } = await account.startLogin(login);
        return json({ status: "ok", url: authUrl, state });
      }
      // Kimi's device flow, answered as CPA answers it.
      const domain = provider === "kimi-ai" ? "kimi.ai" : url.searchParams.get("domain") || url.searchParams.get("channel") || "";
      const started = await account.startLogin(login, domain).catch(() => null);
      if (started === null) return failure(500, "failed to generate authorization url");
      return json({ status: "ok", url: started.url, state: started.state, flow: "device", ...(started.userCode === undefined ? {} : { user_code: started.userCode }), ...(started.expiresIn === undefined ? {} : { expires_in: started.expiresIn }) });
    }
    case "POST import": {
      const provider = url.searchParams.get("provider")?.trim().toLowerCase() ?? "";
      if (provider === "") return failure(400, "provider is required");
      if (provider !== "vertex") return failure(404, "provider_not_found");
      return importVertex(request, url, account);
    }
    case "GET status": {
      const state = url.searchParams.get("state")?.trim() ?? "";
      if (state === "") return json({ status: "ok" });
      const found = account.session(state);
      if (found === null) return json({ status: "error", error: "unknown or expired state" });
      const session = await account.pollDevice(found);
      if (session.status === "ok") return json({ status: "ok" });
      if (session.status === "error") return json({ status: "error", error: session.error });
      return json({ status: "wait" });
    }
    case "DELETE session": {
      const state = url.searchParams.get("state")?.trim() ?? "";
      if (state === "") return json({ status: "error", error: "missing state" }, 400);
      return json({ status: "ok", cancelled: account.vault.removeSession(state) });
    }
    case "GET callback":
    case "POST callback": {
      let fields: Record<string, unknown> = Object.fromEntries(url.searchParams);
      if (request.method === "POST") {
        const body = await readJson(request);
        if (!body.ok || typeof body.value !== "object" || body.value === null) return json({ status: "error", error: "invalid body" }, 400);
        fields = body.value as Record<string, unknown>;
      }
      const text = (key: string) => (typeof fields[key] === "string" ? String(fields[key]).trim() : "");
      let state = text("state");
      let code = text("code");
      let error = text("error") || text("error_description");
      const redirect = text("redirect_url");
      if (redirect !== "") {
        let parsed: URL;
        try {
          parsed = new URL(redirect);
        } catch {
          return json({ status: "error", error: "invalid redirect_url" }, 400);
        }
        state ||= parsed.searchParams.get("state") ?? "";
        code ||= parsed.searchParams.get("code") ?? "";
        error ||= parsed.searchParams.get("error") ?? parsed.searchParams.get("error_description") ?? "";
      }
      if (state === "") return json({ status: "error", error: "state is required" }, 400);
      if (code === "" && error === "") return json({ status: "error", error: "code or error is required" }, 400);
      const result = await account.finishLogin(state, code, error);
      return result.error === undefined ? json({ status: "ok" }) : json({ status: "error", error: result.error }, result.status);
    }
    default:
      return failure(404, "not_found");
  }
}

export async function handleManagement(request: Request, account: Account): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(MANAGEMENT_PREFIX.length).replace(/^\/+|\/+$/g, "");
  const parts = path === "" ? [] : path.split("/").map(decodeURIComponent);
  const [head, ...rest] = parts;
  const route = `${request.method} ${parts.join("/")}`;
  const response = await (async (): Promise<Response> => {
    if (head === "config.yaml" && rest.length === 0) return configRoute(request, [], true, account);
    if (head === "config") return configRoute(request, rest, false, account);
    if (head === "oauth" && rest.length === 1) return oauthRoute(request, url, rest[0] as string, account);
    switch (route) {
      case "GET credentials":
        return listCredentials(url, account);
      case "POST credentials":
        return uploadCredentials(request, url, account);
      case "DELETE credentials":
        return deleteCredentials(request, url, account);
      case "GET credentials/download": {
        const file = account.vault.credentialFile(url.searchParams.get("name")?.trim() ?? "");
        if (file === null) return failure(404, "auth file not found");
        return new Response(JSON.stringify(file.data, null, 2), {
          headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${file.name.replaceAll('"', "")}"`, "cache-control": "no-store" },
        });
      }
      case "PATCH credentials/status":
        return patchCredential(request, account, false);
      case "PATCH credentials/fields":
        return patchCredential(request, account, true);
      case "GET credentials/models": {
        const file = account.vault.credentialFile(url.searchParams.get("name")?.trim() ?? "");
        if (file === null) return failure(404, "auth file not found");
        return json({ models: await loginModels(file, account) });
      }
      case "POST credentials/refresh": {
        const refreshed: string[] = [];
        for (const file of LOGIN_PROVIDERS.flatMap((provider) => account.loginFiles(provider))) if ((await account.tokenFor(file, true)).ok) refreshed.push(file.name);
        return json({ status: "ok", refreshed: refreshed.length, files: refreshed });
      }
      case "GET observability/logs":
        return logs(url, account);
      case "DELETE observability/logs":
        if (!account.loggingEnabled()) return failure(400, "logging to file disabled");
        account.vault.usage.clearLines();
        return json({ success: true, message: "Logs cleared successfully", removed: 0 });
      case "GET observability/logs/errors":
        return json({ files: [] });
      case "GET observability/usage/api-keys":
        return apiKeyUsage(account);
      case "GET observability/usage/queue":
        return json([]);
      case "GET plugins":
        return json({ plugins_enabled: false, plugins_dir: "plugins", plugins: [] });
      case "GET plugins/store":
        return json({ plugins: [] });
      case "GET server/latest-version":
        return json({ "latest-version": GATEWAY_VERSION });
      case "POST routing/cooldown/reset":
        return json({ status: "ok" });
      default:
        if (request.method === "GET" && head === "routing" && rest[0] === "model-definitions" && rest.length === 2) {
          const channel = (rest[1] as string).trim().toLowerCase();
          const source = definitionChannel(channel);
          if (source === null) return failure(400, "unknown channel", { channel: rest[1] });
          return json({ channel, models: (await catalogOf(account))[source].map(definition) });
        }
        return failure(404, "not_found");
    }
  })();
  response.headers.set("x-cpa-version", GATEWAY_VERSION);
  return response;
}
