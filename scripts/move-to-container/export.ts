import { parseDocument } from "yaml";
import { passwordMatches } from "../../worker/src/session.ts";
import { CONFIG_KEY, IMPORT_KEY } from "../../src/import-config.ts";

// A short-lived Worker that scripts/move-to-container.sh deploys next to the Workers-only install.
// It reads the install's Durable Object through a binding to that Worker's Store class, and writes
// into the Container install's R2 bucket:
// - a full copy under backup/workers-only-<time>/,
// - the config at import/config.yaml, which CPA takes on its first start (src/import-config.ts),
// - each login and key file under auths/, where CPA keeps its auth files.
// It answers with counts only, never with keys or tokens.

interface Store {
  manage(request: Request): Promise<Response>;
}

interface Env {
  readonly STORE: DurableObjectNamespace;
  readonly STATE: R2Bucket;
  readonly MOVE_TOKEN?: string;
}

interface Listed {
  readonly name: string;
  readonly disabled: boolean;
}

const MIN_TOKEN_LENGTH = 32;
// CPA auth file names: one path segment, as the Workers-only install names them.
const SAFE_NAME = /^[A-Za-z0-9@._+-]{1,200}\.json$/;

class ExportError extends Error {}

function manage(store: Store, path: string): Promise<Response> {
  return store.manage(new Request(`https://sub2api.internal/v8/management/${path}`));
}

async function read(store: Store, path: string): Promise<Response> {
  const response = await manage(store, path);
  if (!response.ok) throw new ExportError(`reading ${path.split("?")[0]} answered ${response.status}`);
  return response;
}

function listed(body: unknown): Listed[] {
  const files = typeof body === "object" && body !== null && "files" in body ? body.files : null;
  if (!Array.isArray(files)) throw new ExportError("credentials list has no files");
  return files.map((file: unknown) => {
    const name = typeof file === "object" && file !== null && "name" in file ? file.name : null;
    if (typeof name !== "string") throw new ExportError("credentials list has a file without a name");
    return { name, disabled: typeof file === "object" && file !== null && "disabled" in file && file.disabled === true };
  });
}

function apiKeyCount(configText: string): number {
  const keys = parseDocument(configText).toJS()?.access?.["api-keys"];
  return Array.isArray(keys) ? keys.length : 0;
}

async function exportAll(env: Env): Promise<Record<string, unknown>> {
  const store = env.STORE.get(env.STORE.idFromName("main")) as unknown as Store;
  const backup = `backup/workers-only-${new Date().toISOString().replace(/[:.]/g, "-")}/`;
  const put = (key: string, body: string) => env.STATE.put(key, body);

  // Until CPA's first start the bucket holds only what an earlier export put there, so a new
  // export replaces it. Once CPA runs, its own files win.
  const hasConfig = (await env.STATE.head(CONFIG_KEY)) !== null;
  const configText = await (await read(store, "config.yaml")).text();
  const listBody: unknown = await (await read(store, "credentials")).json();
  const files = listed(listBody);
  await put(`${backup}config.yaml`, configText);
  await put(`${backup}credentials.json`, JSON.stringify(listBody, null, 2));

  let moved = 0;
  let kept = 0;
  let disabled = 0;
  for (const file of files) {
    if (!SAFE_NAME.test(file.name) || file.name.includes("..")) throw new ExportError("an auth file has a name CPA can't store");
    const text = await (await read(store, `credentials/download?name=${encodeURIComponent(file.name)}`)).text();
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new ExportError("an auth file is not a JSON object");
    await put(`${backup}auths/${file.name}`, text);
    if (file.disabled) disabled += 1;
    if (hasConfig && (await env.STATE.head(`auths/${file.name}`)) !== null) {
      kept += 1;
      continue;
    }
    // CPA reads a disabled login from the file's own "disabled" field.
    await put(`auths/${file.name}`, JSON.stringify({ ...data, ...(file.disabled ? { disabled: true } : {}) }, null, 2));
    moved += 1;
  }

  // Usage counts and request logs have no place in CPA's storage, so they go to the backup only.
  for (const [path, name] of [["observability/logs", "logs.json"], ["observability/usage/api-keys", "api-key-usage.json"]] as const) {
    const response = await manage(store, path);
    if (response.ok) await put(`${backup}${name}`, await response.text());
  }

  if (!hasConfig) await put(IMPORT_KEY, configText);
  return {
    backup,
    config: hasConfig ? "kept the Container install's own config" : `waiting at ${IMPORT_KEY} for CPA's first start`,
    gateway_api_keys: apiKeyCount(configText),
    auth_files: files.length,
    auth_files_moved: moved,
    auth_files_already_there: kept,
    auth_files_disabled: disabled,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/export") return new Response("Not found\n", { status: 404 });
    const token = env.MOVE_TOKEN ?? "";
    const given = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim() ?? "";
    if (token.length < MIN_TOKEN_LENGTH || !(await passwordMatches(given, token))) return new Response("Unauthorized\n", { status: 401 });
    try {
      return Response.json(await exportAll(env));
    } catch (error) {
      const message = error instanceof ExportError ? error.message : "export failed";
      return Response.json({ error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
