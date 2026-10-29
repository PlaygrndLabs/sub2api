import { CODEX_TEMPLATES } from "./codex-client-catalog.ts";
import type { ServedModel } from "./models.ts";

// The Codex CLI's own model catalog, which it asks for with ?client_version= when a provider sets
// model_catalog_url. As in CPA, a model with a Codex template gets that template (its prompts
// included), and any other model gets the default template with a short prompt, marked so the
// CLI doesn't use features only the ChatGPT backend has.

export interface CodexTemplate {
  // Every template field but the instructions.
  readonly fields: Readonly<Record<string, unknown>>;
  // The instruction fields as ready JSON ("base_instructions":…,"model_messages":…).
  readonly instructions: string;
}

const DEFAULT_TEMPLATE = "gpt-5.5";
// Below Codex's 1 MiB cap, with room to spare.
const MAX_CATALOG_BYTES = 1_000_000;
const FALLBACK_INSTRUCTIONS = "You are Codex, a coding agent. You and the user share one workspace.";
const COMPACT_INSTRUCTIONS = `"base_instructions":${JSON.stringify(FALLBACK_INSTRUCTIONS)},"model_messages":${JSON.stringify({
  instructions_template: FALLBACK_INSTRUCTIONS,
  instructions_variables: null,
  approvals: null,
  collaboration_modes: null,
  auto_review: null,
  permissions: null,
  multi_agent: null,
})}`;
const LEGACY_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const LEVELS = new Set([...LEGACY_LEVELS, "max", "ultra"]);
// Image, video and speech models, which the CLI must not offer as chat models.
const NOT_CHAT = new Set([
  "grok-imagine-image-quality",
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "grok-imagine-image",
  "grok-imagine-image-2.0",
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  "grok-imagine-video-1.5-preview",
  "grok-tts",
  "grok-voice-tts-1.0",
]);
const LEVEL_DESCRIPTIONS: Record<string, string> = {
  none: "No reasoning",
  minimal: "Fastest responses with minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum available reasoning depth for complex problems",
};

type Entry = Record<string, unknown>;

function afterSlash(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1).trim();
}

// Versions before 0.144.0 don't know the "max" and "ultra" efforts; an unreadable version does.
function extendedLevels(clientVersion: string): boolean {
  const version = clientVersion.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
  if (version === "") return true;
  const parts = version.split(".").filter((part) => part.trim() !== "");
  if (parts.some((part) => !/^\d+$/.test(part.trim()))) return true;
  const [major = 0, minor = 0] = parts.map(Number);
  return major > 0 || minor >= 144;
}

function level(raw: unknown, clientVersion: string): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (extendedLevels(clientVersion) ? LEVELS : LEGACY_LEVELS).has(value) ? value : "";
}

// Effort levels from the catalog's thinking metadata, as CPA writes them for a non-template model.
function applyThinking(entry: Entry, levels: readonly string[], clientVersion: string): void {
  const kept: Entry[] = [];
  let defaultLevel = "";
  for (const raw of levels) {
    const effort = level(raw, clientVersion);
    if (effort === "") continue;
    if ((defaultLevel === "" && effort !== "none") || effort === "medium") defaultLevel = effort;
    kept.push({ effort, description: LEVEL_DESCRIPTIONS[effort] ?? effort });
  }
  entry.supported_reasoning_levels = kept;
  if (kept.length === 0) delete entry.default_reasoning_level;
  else entry.default_reasoning_level = defaultLevel || kept[0]?.effort;
}

// Drops efforts this client version doesn't know, keeping the default one of the rest.
function sanitizeThinking(entry: Entry, clientVersion: string): void {
  if (!Array.isArray(entry.supported_reasoning_levels)) return;
  const kept: Entry[] = [];
  for (const raw of entry.supported_reasoning_levels as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const effort = level((raw as Entry).effort, clientVersion);
    if (effort !== "") kept.push({ ...(raw as Entry), effort });
  }
  entry.supported_reasoning_levels = kept;
  if (kept.length === 0) {
    delete entry.default_reasoning_level;
    return;
  }
  const wanted = level(entry.default_reasoning_level, clientVersion);
  entry.default_reasoning_level = kept.some((item) => item.effort === wanted) ? wanted : kept[0]?.effort;
}

// Capabilities only the ChatGPT backend has. Codex refuses a catalog that leaves these keys out.
function clearBackendOptions(entry: Entry): void {
  entry.prefer_websockets = false;
  entry.service_tiers = [];
  entry.apply_patch_tool_type = null;
  entry.tool_mode = "direct";
  entry.use_responses_lite = false;
  entry.supports_reasoning_effort_updates = false;
  entry.upgrade = null;
  entry.availability_nux = null;
}

function applyInputModalities(entry: Entry, modalities: readonly string[] | undefined): void {
  const kept = [...new Set((modalities ?? []).map((item) => item.trim().toLowerCase()).filter((item) => item === "text" || item === "image"))];
  if (kept.length === 0) return;
  entry.input_modalities = kept;
  if (kept.includes("image")) entry.supports_image_detail_original = true;
  else delete entry.supports_image_detail_original;
}

// CPA keeps a template's apply_patch tool only for chat models that take text.
function applyPatchTool(entry: Entry, id: string): void {
  const supported = entry.apply_patch_tool_type === "freeform";
  entry.apply_patch_tool_type = null;
  if (NOT_CHAT.has(afterSlash(id).toLowerCase())) return;
  const modalities = Array.isArray(entry.input_modalities) ? (entry.input_modalities as unknown[]) : [];
  if (!modalities.includes("text") && (modalities.length > 0 || entry.visibility === "hide")) return;
  if (supported) entry.apply_patch_tool_type = "freeform";
}

function priorityOf(entry: Entry): number {
  return typeof entry.priority === "number" ? entry.priority : 100;
}

// Codex's GET {model_catalog_url}?client_version=, as one JSON body. Built as text so the
// templates' prompts (most of the body) are copied, not encoded again on every request.
export function codexModelCatalog(models: readonly ServedModel[], clientVersion: string): string {
  const fallback = CODEX_TEMPLATES[DEFAULT_TEMPLATE] ?? Object.values(CODEX_TEMPLATES)[0];
  if (fallback === undefined) return '{"models":[]}';
  const entries: { entry: Entry; instructions: string; template: boolean }[] = [];
  for (const { model, providers, upstream } of models) {
    const id = model.id;
    const onlyCodex = providers.length > 0 && providers.every((provider) => provider === "codex");
    const template = CODEX_TEMPLATES[upstream] ?? CODEX_TEMPLATES[afterSlash(id)];
    if (template !== undefined) {
      const entry: Entry = { ...template.fields, slug: id };
      if (model.display_name !== undefined) entry.display_name = model.display_name;
      if (model.description !== undefined) entry.description = model.description;
      if (model.max_completion_tokens !== undefined) entry.max_tokens = model.max_completion_tokens;
      if (!onlyCodex) clearBackendOptions(entry);
      // Codex's own tool search only works where the ChatGPT backend answers it.
      if (entry.supports_search_tool === true && !onlyCodex) entry.supports_search_tool = false;
      entries.push({ entry, instructions: template.instructions, template: true });
      continue;
    }
    const entry: Entry = { ...fallback.fields };
    applyInputModalities(entry, model.supportedInputModalities);
    if (model.thinking !== undefined) applyThinking(entry, model.thinking.levels ?? [], clientVersion);
    entry.slug = id;
    entry.display_name = model.display_name ?? id;
    entry.description = model.description ?? id;
    clearBackendOptions(entry);
    if (model.context_length !== undefined) {
      entry.context_window = model.context_length;
      entry.max_context_window = model.context_length;
    }
    if (model.max_completion_tokens !== undefined) entry.max_tokens = model.max_completion_tokens;
    if (entry.supports_search_tool === true) entry.supports_search_tool = false;
    entries.push({ entry, instructions: COMPACT_INSTRUCTIONS, template: false });
  }
  for (const { entry } of entries) {
    delete entry.cpa_capabilities;
    sanitizeThinking(entry, clientVersion);
    if (NOT_CHAT.has(afterSlash(String(entry.slug)))) entry.visibility = "hide";
    applyPatchTool(entry, String(entry.slug));
  }
  // Models without a template follow the templates' own, by display name.
  const base = Math.max(0, ...Object.values(CODEX_TEMPLATES).map((template) => priorityOf(template.fields as Entry)));
  const others = entries.filter((item) => !item.template).map((item) => item.entry);
  others.sort((a, b) => {
    const left = String(a.display_name ?? a.slug).toLowerCase();
    const right = String(b.display_name ?? b.slug).toLowerCase();
    return left === right ? (String(a.slug) < String(b.slug) ? -1 : 1) : left < right ? -1 : 1;
  });
  others.forEach((entry, rank) => (entry.priority = base + 100 * (rank + 1)));
  entries.sort((a, b) => priorityOf(a.entry) - priorityOf(b.entry));
  const parts = entries.map((item) => ({ ...item, fields: JSON.stringify(item.entry).slice(1, -1) }));
  fitBody(parts);
  return `{"models":[${parts.map(({ fields, instructions }) => `{${fields},${instructions}}`).join(",")}]}`;
}

const encoder = new TextEncoder();
const byteLengths = new Map<string, number>();

function bytes(text: string): number {
  let length = byteLengths.get(text);
  if (length === undefined) {
    length = encoder.encode(text).length;
    if (text.length > 1000) byteLengths.set(text, length);
  }
  return length;
}

// Codex reads at most 1 MiB of catalog and otherwise keeps its built-in one, so past that the
// full prompts give way to the short one: repeated templates first (a prefixed copy of a model
// already listed), then the least preferred models.
function fitBody(parts: { fields: string; instructions: string; template: boolean }[]): void {
  let size = 16 + parts.reduce((sum, part) => sum + bytes(part.fields) + bytes(part.instructions) + 3, 0);
  if (size <= MAX_CATALOG_BYTES) return;
  const seen = new Set<string>();
  const repeats: typeof parts = [];
  const firsts: typeof parts = [];
  for (const part of parts) {
    if (!part.template) continue;
    (seen.has(part.instructions) ? repeats : firsts).push(part);
    seen.add(part.instructions);
  }
  for (const part of [...repeats.reverse(), ...firsts.reverse()]) {
    if (size <= MAX_CATALOG_BYTES) return;
    size += bytes(COMPACT_INSTRUCTIONS) - bytes(part.instructions);
    part.instructions = COMPACT_INSTRUCTIONS;
  }
}
