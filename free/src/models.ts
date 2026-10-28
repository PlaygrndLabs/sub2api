import type { Fetcher } from "./claude-oauth.ts";
import { EMBEDDED_CATALOG } from "./model-catalog.ts";
import { excluded, type ProviderKind, type RoutingTable, type UpstreamCredential } from "./providers.ts";

// The model lists: every model the gateway's logins and API keys serve, in the shape each
// client's SDK expects. As in CPA, a provider with no model list of its own serves CPA's
// catalog for its channel, and a ChatGPT login serves the catalog for its plan.

// Where CPA itself refreshes its catalog from, every three hours.
export const CATALOG_URL = "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json";
const REFRESH_SECONDS = 3 * 60 * 60;
// After a failed refresh, the next try waits this long instead.
const RETRY_SECONDS = 10 * 60;
const FETCH_TIMEOUT_MS = 5000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CHANNEL_MODELS = 500;
const MAX_TEXT = 1000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,199}$/;
// CPA's defaults for Claude models that don't state their limits.
const CLAUDE_MAX_INPUT_TOKENS = 200_000;
const CLAUDE_MAX_OUTPUT_TOKENS = 64_000;

export const CHANNELS = ["claude", "gemini", "codex-free", "codex-team", "codex-plus", "codex-pro", "xai"] as const;
export type Channel = (typeof CHANNELS)[number];

// One model as CPA's catalog describes it, with the fields the model lists use.
export interface CatalogModel {
  readonly id: string;
  readonly created?: number;
  readonly owned_by?: string;
  readonly type?: string;
  readonly display_name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly context_length?: number;
  readonly max_completion_tokens?: number;
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
  readonly supportedGenerationMethods?: readonly string[];
  readonly supportedInputModalities?: readonly string[];
  readonly supportedOutputModalities?: readonly string[];
}

export type Catalog = Readonly<Record<Channel, readonly CatalogModel[]>>;

const TEXT_FIELDS = ["owned_by", "type", "display_name", "version", "description"] as const;
const NUMBER_FIELDS = ["created", "context_length", "max_completion_tokens", "inputTokenLimit", "outputTokenLimit"] as const;
const LIST_FIELDS = ["supportedGenerationMethods", "supportedInputModalities", "supportedOutputModalities"] as const;

function catalogModel(value: unknown): CatalogModel | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !MODEL_ID.test(entry.id)) return null;
  const model: Record<string, unknown> = { id: entry.id };
  for (const field of TEXT_FIELDS) {
    const text = entry[field];
    if (typeof text === "string" && text !== "") model[field] = text.slice(0, MAX_TEXT);
  }
  for (const field of NUMBER_FIELDS) {
    const number = entry[field];
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) model[field] = number;
  }
  for (const field of LIST_FIELDS) {
    const list = entry[field];
    if (Array.isArray(list)) model[field] = list.filter((item): item is string => typeof item === "string" && item.length <= 64).slice(0, 32);
  }
  return model as unknown as CatalogModel;
}

// Checks a downloaded catalog the way CPA does: every channel must be there and non-empty.
// Only plain names, numbers and short texts are kept, since the file comes from outside.
export function parseCatalog(value: unknown): Catalog | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const catalog: Partial<Record<Channel, CatalogModel[]>> = {};
  for (const channel of CHANNELS) {
    const list = root[channel];
    if (!Array.isArray(list)) return null;
    const models = list.slice(0, MAX_CHANNEL_MODELS).flatMap((entry) => catalogModel(entry) ?? []);
    if (models.length === 0) return null;
    catalog[channel] = models;
  }
  return catalog as Catalog;
}

async function boundedText(response: Response, limit: number): Promise<string | null> {
  if (Number(response.headers.get("content-length") ?? "0") > limit || response.body === null) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchCatalog(fetcher: Fetcher): Promise<Catalog | null> {
  try {
    const response = await fetcher(new Request(CATALOG_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const text = await boundedText(response, MAX_CATALOG_BYTES);
    return text === null ? null : parseCatalog(JSON.parse(text));
  } catch {
    return null;
  }
}

// The catalog this isolate serves: the embedded snapshot until a refresh from upstream lands.
export class CatalogCache {
  private catalog: Catalog = EMBEDDED_CATALOG;
  private nextCheck = 0;

  current(): Catalog {
    return this.catalog;
  }

  // Starts a refresh when one is due, and returns it for the caller to wait on or hand to
  // waitUntil; null when none is due. A refresh never rejects.
  refresh(fetcher: Fetcher, now: number): Promise<void> | null {
    if (now < this.nextCheck) return null;
    this.nextCheck = now + RETRY_SECONDS;
    return fetchCatalog(fetcher).then((catalog) => {
      if (catalog === null) return;
      this.catalog = catalog;
      this.nextCheck = now + REFRESH_SECONDS;
    });
  }
}

// CPA's catalog for a ChatGPT login's plan; Pro's when the plan is unknown.
export function codexChannel(plan: string): Channel {
  switch (plan.trim().toLowerCase()) {
    case "free":
      return "codex-free";
    case "plus":
      return "codex-plus";
    case "team":
    case "business":
    case "go":
      return "codex-team";
    default:
      return "codex-pro";
  }
}

// CPA's channel names for the dashboard's model definitions.
export function definitionChannel(name: string): Channel | null {
  switch (name.trim().toLowerCase()) {
    case "claude":
      return "claude";
    case "gemini":
    case "gemini-interactions":
      return "gemini";
    case "codex":
      return "codex-pro";
    case "xai":
      return "xai";
    default:
      return null;
  }
}

const OWNER: Record<ProviderKind, { owned_by: string; type: string; channel: Channel | null }> = {
  claude: { owned_by: "anthropic", type: "claude", channel: "claude" },
  gemini: { owned_by: "google", type: "gemini", channel: "gemini" },
  codex: { owned_by: "openai", type: "openai", channel: "codex-pro" },
  xai: { owned_by: "xai", type: "xai", channel: "xai" },
  "openai-compatibility": { owned_by: "", type: "openai-compatibility", channel: null },
};

// The models one API key serves, by the names clients ask for, before its prefix.
function credentialModels(credential: UpstreamCredential, catalog: Catalog, now: number): CatalogModel[] {
  const owner = OWNER[credential.kind];
  if (credential.models.length > 0) {
    const compat = credential.kind === "openai-compatibility";
    return credential.models
      .filter((mapping) => !excluded(mapping.name, credential.excluded))
      .map((mapping) => ({ id: mapping.alias, created: now, owned_by: compat ? credential.group : owner.owned_by, type: owner.type, display_name: compat ? mapping.alias : mapping.name }));
  }
  if (owner.channel === null) return [];
  return catalog[owner.channel].filter((model) => !excluded(model.id, credential.excluded));
}

// Every model clients can ask for by name, once each: the logins' first, then the API keys'
// in config order. A prefixed key's models are listed both bare and as "prefix/model", as in
// CPA, since the bare name reaches them too.
export function availableModels(table: RoutingTable, catalog: Catalog, now: number): CatalogModel[] {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  const add = (model: CatalogModel) => {
    if (seen.has(model.id)) return;
    seen.add(model.id);
    models.push(model);
  };
  if (table.claudeOAuth) catalog.claude.forEach(add);
  if (table.codexOAuth) {
    const plans = table.codexPlans === undefined || table.codexPlans.length === 0 ? [""] : table.codexPlans;
    for (const plan of plans) catalog[codexChannel(plan)].forEach(add);
  }
  for (const credential of table.credentials) {
    for (const model of credentialModels(credential, catalog, now)) {
      add(model);
      if (credential.prefix !== "") add({ ...model, id: `${credential.prefix}/${model.id}` });
    }
  }
  return models;
}

// OpenAI's GET /v1/models, with the four fields CPA keeps.
export function openaiModelList(models: readonly CatalogModel[]): unknown {
  const data = models.map((model) => ({ id: model.id, object: "model", ...(model.created === undefined ? {} : { created: model.created }), owned_by: model.owned_by ?? "" }));
  return { object: "list", data };
}

// Anthropic's GET /v1/models, sorted by display name as CPA sorts it. CPA's cloaking renames
// non-Claude models for Claude Code; that isn't ported, so every name is listed as it is.
export function claudeModelList(models: readonly CatalogModel[]): unknown {
  const data = models
    .map((model) => ({
      id: model.id,
      object: "model",
      owned_by: model.owned_by ?? "",
      ...(model.created === undefined ? {} : { created_at: new Date(model.created * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") }),
      type: "model",
      display_name: model.display_name ?? model.id,
      max_input_tokens: model.context_length ?? CLAUDE_MAX_INPUT_TOKENS,
      max_tokens: model.max_completion_tokens ?? CLAUDE_MAX_OUTPUT_TOKENS,
    }))
    .sort((a, b) => (a.display_name === b.display_name ? compare(a.id, b.id) : compare(a.display_name, b.display_name)));
  return { data, has_more: false, first_id: data[0]?.id ?? "", last_id: data.at(-1)?.id ?? "" };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// One model in Gemini's shape, as CPA's Gemini handler fills it in.
export function geminiModel(model: CatalogModel): Record<string, unknown> {
  const inputTokenLimit = model.inputTokenLimit ?? model.context_length;
  const outputTokenLimit = model.outputTokenLimit ?? model.max_completion_tokens;
  return {
    name: `models/${model.id}`,
    ...(model.version === undefined ? {} : { version: model.version }),
    displayName: model.display_name ?? model.id,
    description: model.description ?? model.id,
    ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
    ...(outputTokenLimit === undefined ? {} : { outputTokenLimit }),
    supportedGenerationMethods: model.supportedGenerationMethods ?? ["generateContent"],
    ...(model.supportedInputModalities === undefined ? {} : { supportedInputModalities: model.supportedInputModalities }),
    ...(model.supportedOutputModalities === undefined ? {} : { supportedOutputModalities: model.supportedOutputModalities }),
  };
}

// Gemini's GET /v1beta/models.
export function geminiModelList(models: readonly CatalogModel[]): unknown {
  return { models: models.map(geminiModel) };
}

// A model as the dashboard's management calls describe it.
export function definition(model: CatalogModel): Record<string, unknown> {
  const { id, ...rest } = model;
  return { id, object: "model", ...rest };
}
