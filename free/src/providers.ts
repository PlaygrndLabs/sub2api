import type { Cooldown, RoutingSettings } from "./routing.ts";

// The API-key upstreams configured under CPA's `api-keys` config section, and how a requested
// model is matched to them. Each provider holds named groups (one endpoint, shared settings)
// and a list of keys; a key may override the group's settings, as in CPA.

// "kimi" is a Kimi login served like a key; CPA's config has no Kimi keys, so it isn't read there.
export type ProviderKind = "claude" | "gemini" | "vertex" | "codex" | "xai" | "kimi" | "openai-compatibility";
// The request shapes clients send: Anthropic Messages, OpenAI Chat Completions, OpenAI
// Responses, and Gemini generateContent.
export type Format = "claude" | "openai" | "openai-response" | "gemini";

export const PROVIDER_KINDS: readonly ProviderKind[] = ["claude", "gemini", "vertex", "codex", "xai", "openai-compatibility"];

export const NATIVE_FORMAT: Record<ProviderKind, Format> = {
  claude: "claude",
  gemini: "gemini",
  vertex: "gemini",
  codex: "openai-response",
  xai: "openai-response",
  kimi: "claude",
  "openai-compatibility": "openai",
};

// xAI also serves OpenAI Chat Completions itself, and Kimi both OpenAI formats as well as
// Anthropic's, so those clients reach them untranslated.
export function takesNatively(kind: ProviderKind, format: Format): boolean {
  if (kind === "xai") return format === "openai-response" || format === "openai";
  if (kind === "kimi") return format !== "gemini";
  return NATIVE_FORMAT[kind] === format;
}

export const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  claude: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  vertex: "https://aiplatform.googleapis.com",
  codex: "https://chatgpt.com/backend-api/codex",
  xai: "https://api.x.ai/v1",
  kimi: "https://api.kimi.com/coding",
  "openai-compatibility": "",
};

// Models a provider serves when its group lists none, as CPA's built-in catalog does.
const DEFAULT_FAMILY: Record<ProviderKind, RegExp | null> = {
  claude: /^claude-/i,
  gemini: /^gemini-/i,
  vertex: /^gemini-/i,
  codex: /^(gpt-|codex-|o\d)/i,
  xai: /^grok-/i,
  kimi: /^kimi-/i,
  "openai-compatibility": null,
};

export interface ModelMapping {
  readonly name: string;
  readonly alias: string;
}

// One upstream key with its group's settings resolved. Plain data, so the Durable Object can
// hand the whole table to the Worker.
export interface UpstreamCredential {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly group: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly weight: number;
  readonly priority: number;
  readonly prefix: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly models: readonly ModelMapping[];
  readonly excluded: readonly string[];
  // CPA's per-key overrides; null inherits the routing section's value.
  readonly disableCooling: boolean | null;
  readonly requestRetry: number | null;
}

// One enabled subscription login, with the routing fields CPA reads from its auth file.
export interface LoginEntry {
  readonly name: string;
  readonly provider: "claude" | "codex" | "kimi" | "vertex";
  readonly priority: number;
  readonly weight: number;
  readonly prefix: string;
  readonly disableCooling: boolean | null;
  readonly requestRetry: number | null;
}

export interface RoutingTable {
  readonly credentials: readonly UpstreamCredential[];
  // Whether at least one Claude OAuth login is enabled.
  readonly claudeOAuth: boolean;
  // Whether at least one ChatGPT (Codex) OAuth login is enabled.
  readonly codexOAuth: boolean;
  // Each enabled login. Left out, the Durable Object picks a login for each token in turn.
  readonly logins?: readonly LoginEntry[];
  // CPA's routing section (strategy, retry rounds, cooldowns); defaults when left out.
  readonly settings?: RoutingSettings;
  // Cooldowns the Durable Object has heard of from every isolate.
  readonly cooldowns?: readonly Cooldown[];
  // The plans of the enabled ChatGPT logins, which decide the models they list.
  readonly codexPlans?: readonly string[];
  // Whether at least one Vertex service account is enabled.
  readonly vertexOAuth?: boolean;
  // Whether at least one Kimi login is enabled.
  readonly kimiOAuth?: boolean;
}

export interface Candidate {
  readonly credential: UpstreamCredential;
  readonly model: string;
}

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// A key's own value wins unless it is missing or null, in which case the group's applies.
function inherit(key: Tree, group: Tree, field: string): unknown {
  return key[field] === undefined || key[field] === null ? group[field] : key[field];
}

function headersOf(value: unknown): Record<string, string> {
  if (!isTree(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([name, header]) => (typeof header === "string" && name.trim() !== "" ? [[name.trim().toLowerCase(), header]] : [])));
}

function modelsOf(value: unknown): ModelMapping[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isTree(entry)) return [];
    const name = text(entry.name);
    if (name === "") return [];
    return [{ name, alias: text(entry.alias) || name }];
  });
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => (text(entry) === "" ? [] : [text(entry)])) : [];
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// CPA reads weight from config as a number and from auth files as a number or a numeric string.
// Non-positive weights take the credential out of weighted round-robin.
export function weightOf(value: unknown): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Math.max(0, Math.min(1_000_000, Math.floor(number(parsed, 1))));
}

export function flagOf(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

// A negative or missing request-retry inherits the routing section's value.
export function retryOf(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

// Reads `api-keys` from the config tree into one flat list of usable credentials.
export function upstreamCredentials(config: unknown): UpstreamCredential[] {
  const root = isTree(config) ? config["api-keys"] : undefined;
  if (!isTree(root)) return [];
  const credentials: UpstreamCredential[] = [];
  for (const kind of PROVIDER_KINDS) {
    const groups = root[kind];
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!isTree(group) || group.disabled === true) return;
      const groupName = text(group.name) || `${kind}-${groupIndex + 1}`;
      const baseUrl = (text(group["base-url"]) || DEFAULT_BASE_URL[kind]).replace(/\/+$/, "");
      if (!/^https:\/\//i.test(baseUrl)) return;
      const keys = Array.isArray(group.keys) ? group.keys : [];
      keys.forEach((key, keyIndex) => {
        if (!isTree(key) || key.disabled === true) return;
        const apiKey = text(key["api-key"]);
        if (apiKey === "") return;
        credentials.push({
          id: `${kind}/${groupName}/${keyIndex}`,
          kind,
          group: groupName,
          baseUrl,
          apiKey,
          weight: weightOf(key.weight),
          priority: number(inherit(key, group, "priority"), 0),
          prefix: text(inherit(key, group, "prefix")),
          headers: headersOf(inherit(key, group, "headers")),
          models: modelsOf(inherit(key, group, "models")),
          excluded: listOf(inherit(key, group, "excluded-models")),
          disableCooling: flagOf(inherit(key, group, "disable-cooling")),
          requestRetry: retryOf(inherit(key, group, "request-retry")),
        });
      });
    });
  }
  return credentials;
}

// CPA's excluded-models patterns: exact names, or one "*" wildcard at the start, end or both.
export function excluded(model: string, patterns: readonly string[]): boolean {
  const name = model.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    if (!pattern.includes("*")) return pattern === name;
    const core = pattern.replace(/^\*|\*$/g, "");
    if (pattern.startsWith("*") && pattern.endsWith("*")) return name.includes(core);
    if (pattern.startsWith("*")) return name.endsWith(core);
    if (pattern.endsWith("*")) return name.startsWith(core);
    const [head = "", tail = ""] = pattern.split("*");
    return name.startsWith(head) && name.endsWith(tail) && name.length >= head.length + tail.length;
  });
}

// Whether a provider kind serves this model by default, without a model list.
export function inDefaultFamily(kind: ProviderKind, model: string): boolean {
  return DEFAULT_FAMILY[kind]?.test(model) ?? false;
}

// The upstream model a credential would use for a requested model, or null if it can't serve it.
function upstreamModel(credential: UpstreamCredential, model: string): string | null {
  let target: string | null = null;
  if (credential.models.length > 0) {
    target = credential.models.find((mapping) => mapping.alias === model)?.name ?? null;
  } else if (DEFAULT_FAMILY[credential.kind]?.test(model)) {
    target = model;
  }
  return target !== null && !excluded(target, credential.excluded) ? target : null;
}

// "prefix/model" targets the credentials and logins carrying that prefix, as in CPA; any other
// model name is matched as it is.
export function splitModel(table: RoutingTable, requested: string): { prefix: string; model: string } {
  const slash = requested.indexOf("/");
  const prefix = slash > 0 ? requested.slice(0, slash) : "";
  if (prefix === "") return { prefix: "", model: requested };
  const known = table.credentials.some((credential) => credential.prefix === prefix) || (table.logins ?? []).some((login) => login.prefix === prefix);
  return known ? { prefix, model: requested.slice(slash + 1) } : { prefix: "", model: requested };
}

// Credentials that can serve the model, highest priority first.
export function candidates(table: RoutingTable, requested: string): Candidate[] {
  const { prefix, model } = splitModel(table, requested);
  const found: Candidate[] = [];
  for (const credential of table.credentials) {
    if (prefix !== "" && credential.prefix !== prefix) continue;
    const target = upstreamModel(credential, model);
    if (target !== null) found.push({ credential, model: target });
  }
  return found.sort((a, b) => b.credential.priority - a.credential.priority);
}

export type Strategy = "round-robin" | "weighted-round-robin" | "fill-first";

// CPA's strategies, within the highest priority: round-robin gives each credential a turn,
// weighted-round-robin gives turns by weight (leaving out weight 0), and fill-first keeps to the
// first until it fails. The lower priorities follow in order, as fallbacks. `found` must be
// sorted by priority, and `turn` is a counter the caller keeps per isolate.
export function ordered(found: readonly Candidate[], turn: number, strategy: Strategy = "round-robin"): Candidate[] {
  const pool = strategy === "weighted-round-robin" ? found.filter((candidate) => candidate.credential.weight > 0) : [...found];
  if (pool.length <= 1 || strategy === "fill-first") return pool;
  const top = pool.filter((candidate) => candidate.credential.priority === pool[0]?.credential.priority);
  const share = (candidate: Candidate) => (strategy === "weighted-round-robin" ? candidate.credential.weight : 1);
  const total = top.reduce((sum, candidate) => sum + share(candidate), 0);
  let slot = turn % total;
  let first = 0;
  for (const [index, candidate] of top.entries()) {
    if (slot < share(candidate)) {
      first = index;
      break;
    }
    slot -= share(candidate);
  }
  const rotated = [...top.slice(first), ...top.slice(0, first)];
  return [...rotated, ...pool.slice(top.length)];
}
