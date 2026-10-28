import { describe, expect, it } from "vitest";
import { CODEX_TEMPLATES } from "../src/codex-client-catalog.ts";
import { codexModelCatalog } from "../src/codex-models.ts";
import { EMBEDDED_CATALOG } from "../src/model-catalog.ts";
import { servedModels } from "../src/models.ts";
import { upstreamCredentials, type RoutingTable } from "../src/providers.ts";

const NOW = 1_800_000_000;

type Entry = Record<string, unknown> & { slug: string; priority: number; base_instructions: string };

const TABLE: RoutingTable = {
  credentials: upstreamCredentials({
    "api-keys": {
      claude: [{ name: "c", keys: [{ "api-key": "sk-ant-1" }] }],
      codex: [{ name: "x", prefix: "team", keys: [{ "api-key": "sk-openai" }] }],
      "openai-compatibility": [{ name: "router", "base-url": "https://router.example/v1", models: [{ name: "gpt-6-luna", alias: "luna-cheap" }], keys: [{ "api-key": "sk-r" }] }],
    },
  }),
  claudeOAuth: false,
  codexOAuth: true,
  codexPlans: ["plus"],
};

function catalog(clientVersion = "0.157.0", table = TABLE): { text: string; models: Entry[] } {
  const text = codexModelCatalog(servedModels(table, EMBEDDED_CATALOG, NOW), clientVersion);
  return { text, models: (JSON.parse(text) as { models: Entry[] }).models };
}

describe("Codex CLI model catalog", () => {
  it("gives Codex models their template and every other model the default one", () => {
    const { text, models } = catalog();
    const bySlug = new Map(models.map((model) => [model.slug, model]));
    const astra = bySlug.get("gpt-6-astra");
    expect(astra?.base_instructions.length).toBeGreaterThan(10_000);
    expect(astra?.priority).toBe(CODEX_TEMPLATES["gpt-6-astra"]?.fields.priority);
    expect(astra?.prefer_websockets).toBe(CODEX_TEMPLATES["gpt-6-astra"]?.fields.prefer_websockets);
    // A Claude model gets the short prompt and none of the ChatGPT backend's features.
    const sonnet = bySlug.get("claude-sonnet-4-6");
    expect(sonnet).toMatchObject({ display_name: "Claude 4.6 Sonnet", prefer_websockets: false, service_tiers: [], tool_mode: "direct", apply_patch_tool_type: null, upgrade: null, supports_search_tool: false, context_window: 200000 });
    expect(sonnet?.base_instructions).toBe("You are Codex, a coding agent. You and the user share one workspace.");
    // Every entry has the fields Codex's ModelInfo requires, since one missing drops the whole catalog.
    const required = ["slug", "display_name", "supported_reasoning_levels", "shell_type", "visibility", "supported_in_api", "priority", "support_verbosity", "truncation_policy", "experimental_supported_tools"];
    for (const model of models) {
      for (const key of required) expect(Object.keys(model)).toContain(key);
      expect(Number.isInteger(model.priority)).toBe(true);
    }
    // Templates first by their own priority, the rest after them by display name.
    const priorities = models.map((model) => model.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(sonnet?.priority).toBeGreaterThan(Math.max(...Object.values(CODEX_TEMPLATES).map((template) => Number(template.fields.priority ?? 0))));
    // Codex reads at most 1 MiB of catalog: past that, the prefixed copies give up their full prompts first.
    expect(new TextEncoder().encode(text).length).toBeLessThan(1_000_000);
    for (const slug of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]) expect(bySlug.get(slug)?.base_instructions.length).toBeGreaterThan(10_000);
    expect(models.filter((model) => model.slug.startsWith("team/")).some((model) => model.base_instructions === sonnet?.base_instructions)).toBe(true);
  });

  it("marks a Codex model served elsewhere too, or through an alias, as not ChatGPT-only", () => {
    const { models } = catalog();
    const bySlug = new Map(models.map((model) => [model.slug, model]));
    // The prefixed Codex key serves "team/…" with Codex's template, still ChatGPT-only.
    expect(bySlug.get("team/gpt-6-astra")?.prefer_websockets).toBe(CODEX_TEMPLATES["gpt-6-astra"]?.fields.prefer_websockets);
    // An OpenAI-compatible alias for a Codex model keeps the model's prompt but not its backend features.
    expect(bySlug.get("luna-cheap")).toMatchObject({ prefer_websockets: false, tool_mode: "direct", apply_patch_tool_type: null, supports_search_tool: false });
    const fitting = new Map(catalog("0.157.0", { ...TABLE, credentials: TABLE.credentials.filter((credential) => credential.prefix === "") }).models.map((model) => [model.slug, model]));
    expect(fitting.get("luna-cheap")?.base_instructions).toBe(fitting.get("gpt-6-luna")?.base_instructions);
  });

  it("drops reasoning efforts an older Codex doesn't know", () => {
    const efforts = (models: Entry[]) => new Set(models.flatMap((model) => ((model.supported_reasoning_levels as { effort: string }[] | undefined) ?? []).map((level) => level.effort)));
    expect(efforts(catalog("0.157.0").models).has("max")).toBe(true);
    const legacy = catalog("0.140.2").models;
    expect(efforts(legacy).has("max")).toBe(false);
    for (const model of legacy) {
      const levels = (model.supported_reasoning_levels as { effort: string }[] | undefined) ?? [];
      if (levels.length > 0) expect(levels.map((level) => level.effort)).toContain(model.default_reasoning_level);
    }
  });

  it("keeps every full prompt when the catalog fits", () => {
    const { models } = catalog("0.157.0", { ...TABLE, credentials: TABLE.credentials.filter((credential) => credential.prefix === "") });
    for (const model of models.filter((entry) => CODEX_TEMPLATES[entry.slug] !== undefined)) expect(model.base_instructions.length).toBeGreaterThan(10_000);
  });

  it("answers with an empty list when nothing is configured", () => {
    expect(catalog("0.157.0", { credentials: [], claudeOAuth: false, codexOAuth: false }).models).toEqual([]);
  });

  it("keeps the instructions out of the per-request fields, so no key appears twice", () => {
    for (const template of Object.values(CODEX_TEMPLATES)) {
      expect(Object.keys(template.fields)).not.toContain("base_instructions");
      expect(Object.keys(template.fields)).not.toContain("model_messages");
      expect(() => JSON.parse(`{${template.instructions}}`)).not.toThrow();
    }
  });
});
