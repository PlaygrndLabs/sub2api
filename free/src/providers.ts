// The API-key upstreams configured under CPA's `api-keys` config section, and how a requested
// model is matched to them. Each provider holds named groups (one endpoint, shared settings)
// and a list of keys; a key may override the group's settings, as in CPA.

export type ProviderKind = "claude" | "gemini" | "codex" | "openai-compatibility";
// The request shapes clients send: Anthropic Messages, OpenAI Chat Completions, OpenAI
// Responses, and Gemini generateContent.
export type Format = "claude" | "openai" | "openai-response" | "gemini";

export const PROVIDER_KINDS: readonly ProviderKind[] = ["claude", "gemini", "codex", "openai-compatibility"];

export const NATIVE_FORMAT: Record<ProviderKind, Format> = {
  claude: "claude",
  gemini: "gemini",
  codex: "openai-response",
  "openai-compatibility": "openai",
};

export const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  claude: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  codex: "https://chatgpt.com/backend-api/codex",
  "openai-compatibility": "",
};

// Models a provider serves when its group lists none, as CPA's built-in catalog does.
const DEFAULT_FAMILY: Record<ProviderKind, RegExp | null> = {
  claude: /^claude-/i,
  gemini: /^gemini-/i,
  codex: /^(gpt-|codex-|o\d)/i,
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
}

export interface RoutingTable {
  readonly credentials: readonly UpstreamCredential[];
  // Whether at least one Claude OAuth login is enabled.
  readonly claudeOAuth: boolean;
  // Whether at least one ChatGPT (Codex) OAuth login is enabled.
  readonly codexOAuth: boolean;
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
          weight: Math.max(1, Math.min(1_000_000, Math.floor(number(key.weight, 1)))),
          priority: number(inherit(key, group, "priority"), 0),
          prefix: text(inherit(key, group, "prefix")),
          headers: headersOf(inherit(key, group, "headers")),
          models: modelsOf(inherit(key, group, "models")),
          excluded: listOf(inherit(key, group, "excluded-models")),
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

// Credentials that can serve the model, highest priority first. "prefix/model" picks the
// credentials carrying that prefix, as in CPA.
export function candidates(table: RoutingTable, requested: string): Candidate[] {
  const slash = requested.indexOf("/");
  const prefix = slash > 0 ? requested.slice(0, slash) : "";
  const prefixed = prefix !== "" && table.credentials.some((credential) => credential.prefix === prefix);
  const model = prefixed ? requested.slice(slash + 1) : requested;
  const found: Candidate[] = [];
  for (const credential of table.credentials) {
    if (prefixed && credential.prefix !== prefix) continue;
    const target = upstreamModel(credential, model);
    if (target !== null) found.push({ credential, model: target });
  }
  return found.sort((a, b) => b.credential.priority - a.credential.priority);
}

// Weighted round-robin within the highest priority, then the rest in priority order as
// fallbacks. `turn` is a counter the caller keeps per isolate.
export function ordered(found: readonly Candidate[], turn: number): Candidate[] {
  if (found.length <= 1) return [...found];
  const top = found.filter((candidate) => candidate.credential.priority === found[0]?.credential.priority);
  const total = top.reduce((sum, candidate) => sum + candidate.credential.weight, 0);
  let slot = turn % total;
  let first = 0;
  for (const [index, candidate] of top.entries()) {
    if (slot < candidate.credential.weight) {
      first = index;
      break;
    }
    slot -= candidate.credential.weight;
  }
  const rotated = [...top.slice(first), ...top.slice(0, first)];
  return [...rotated, ...found.slice(top.length)];
}

// Every model name clients can ask for by name, for the model lists.
export function listedModels(table: RoutingTable): { id: string; kind: ProviderKind }[] {
  const seen = new Set<string>();
  const models: { id: string; kind: ProviderKind }[] = [];
  for (const credential of table.credentials) {
    for (const mapping of credential.models) {
      const id = credential.prefix === "" ? mapping.alias : `${credential.prefix}/${mapping.alias}`;
      if (seen.has(id) || excluded(mapping.name, credential.excluded)) continue;
      seen.add(id);
      models.push({ id, kind: credential.kind });
    }
  }
  return models;
}
