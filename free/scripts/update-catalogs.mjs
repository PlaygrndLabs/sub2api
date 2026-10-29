// Regenerates the built-in copies of CPA's model catalogs from router-for-me/models, where CPA
// itself refreshes them: src/model-catalog.ts (models.json, trimmed to the fields the model lists
// use) and src/codex-client-catalog.ts (codex_client_models.json, the Codex CLI's model
// templates). Run it from free/ with `node scripts/update-catalogs.mjs`, then review the diff.
import { writeFile } from "node:fs/promises";

const BASE = "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main";
const CHANNELS = ["claude", "gemini", "codex-free", "codex-team", "codex-plus", "codex-pro", "xai", "vertex", "kimi"];
const FIELDS = [
  "id",
  "created",
  "owned_by",
  "type",
  "display_name",
  "version",
  "description",
  "context_length",
  "max_completion_tokens",
  "inputTokenLimit",
  "outputTokenLimit",
  "supportedGenerationMethods",
  "supportedInputModalities",
  "supportedOutputModalities",
];
// The Codex template fields sent as they are, kept as ready JSON so no request re-encodes them.
const INSTRUCTION_FIELDS = ["base_instructions", "model_messages"];

async function download(name) {
  const response = await fetch(`${BASE}/${name}`);
  if (!response.ok) throw new Error(`Downloading ${name} failed: ${response.status}`);
  return response.json();
}

function trimmed(model) {
  const out = {};
  for (const field of FIELDS) if (model[field] !== undefined && model[field] !== null && model[field] !== "") out[field] = model[field];
  if (typeof model.thinking === "object" && model.thinking !== null) out.thinking = Array.isArray(model.thinking.levels) ? { levels: model.thinking.levels } : {};
  return out;
}

const catalog = await download("models.json");
const lines = [
  "// A snapshot of CPA's model catalog (router-for-me/models, models.json), trimmed to the channels and",
  "// fields the model lists use. The gateway refreshes it from upstream at run time, as CPA does; this",
  "// copy is what it serves until the first refresh lands, or when upstream can't be reached.",
  "// Regenerate with scripts/update-catalogs.mjs.",
  'import type { Catalog } from "./models.ts";',
  "",
  "export const EMBEDDED_CATALOG: Catalog = {",
];
for (const channel of CHANNELS) {
  if (!Array.isArray(catalog[channel]) || catalog[channel].length === 0) throw new Error(`models.json has no ${channel} models`);
  lines.push(`  ${JSON.stringify(channel)}: [`);
  for (const model of catalog[channel]) lines.push(`    ${JSON.stringify(trimmed(model))},`);
  lines.push("  ],");
}
lines.push("};", "");
await writeFile(new URL("../src/model-catalog.ts", import.meta.url), lines.join("\n"));

const codex = await download("codex_client_models.json");
if (!Array.isArray(codex.models) || codex.models.length === 0) throw new Error("codex_client_models.json has no models");
const fragments = new Map();
const fragment = (text) => {
  if (!fragments.has(text)) fragments.set(text, `F${fragments.size}`);
  return fragments.get(text);
};
const templates = [];
for (const model of codex.models) {
  if (typeof model.slug !== "string" || model.slug.trim() === "") continue;
  const fields = Object.fromEntries(Object.entries(model).filter(([key]) => !INSTRUCTION_FIELDS.includes(key)));
  const parts = INSTRUCTION_FIELDS.filter((key) => model[key] !== undefined).map((key) => fragment(`${JSON.stringify(key)}:${JSON.stringify(model[key])}`));
  templates.push(`  ${JSON.stringify(model.slug.trim())}: { fields: ${JSON.stringify(fields)}, instructions: ${parts.join(' + "," + ')} },`);
}
const codexLines = [
  "// A snapshot of the Codex CLI's model templates (router-for-me/models, codex_client_models.json),",
  "// which CPA uses to answer the Codex CLI's model catalog request. The instruction fields are kept",
  "// as ready JSON, so a request copies them without encoding about a megabyte of prompts.",
  "// Regenerate with scripts/update-catalogs.mjs.",
  'import type { CodexTemplate } from "./codex-models.ts";',
  "",
  ...[...fragments].map(([text, name]) => `const ${name} = ${JSON.stringify(text)};`),
  "",
  "export const CODEX_TEMPLATES: Readonly<Record<string, CodexTemplate>> = {",
  ...templates,
  "};",
  "",
];
await writeFile(new URL("../src/codex-client-catalog.ts", import.meta.url), codexLines.join("\n"));
console.log(`Saved ${CHANNELS.length} catalog channels and ${templates.length} Codex templates (${fragments.size} instruction blocks)`);
