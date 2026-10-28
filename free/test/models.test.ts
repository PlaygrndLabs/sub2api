import { describe, expect, it } from "vitest";
import { EMBEDDED_CATALOG } from "../src/model-catalog.ts";
import { CATALOG_URL, CatalogCache, CHANNELS, codexChannel, parseCatalog } from "../src/models.ts";

const NOW = 1_800_000_000;

function catalogWith(claude: unknown[]): Record<string, unknown> {
  return { ...Object.fromEntries(CHANNELS.map((channel) => [channel, [{ id: `${channel}-model` }]])), claude };
}

describe("model catalog", () => {
  it("keeps only plain names, numbers and short texts from a download", () => {
    const parsed = parseCatalog(
      catalogWith([
        { id: "claude-new", display_name: "Claude New", created: 1_790_000_000, context_length: 1e6, thinking: { max: 1 }, description: "x".repeat(5000) },
        { id: "<script>" },
        { id: "claude-odd", created: -1, owned_by: 7, supportedInputModalities: ["text", 3] },
        "not a model",
      ]),
    );
    expect(parsed?.claude).toEqual([
      { id: "claude-new", display_name: "Claude New", created: 1_790_000_000, context_length: 1e6, description: "x".repeat(1000) },
      { id: "claude-odd", supportedInputModalities: ["text"] },
    ]);
  });

  it("refuses a catalog missing a channel, as CPA does", () => {
    expect(parseCatalog(catalogWith([]))).toBeNull();
    expect(parseCatalog({ claude: [{ id: "claude-x" }] })).toBeNull();
    expect(parseCatalog([])).toBeNull();
    expect(parseCatalog(EMBEDDED_CATALOG)).toEqual(EMBEDDED_CATALOG);
  });

  it("refreshes from CPA's catalog every three hours, keeping the last good one", async () => {
    const cache = new CatalogCache();
    const fresh = catalogWith([{ id: "claude-fresh" }]);
    let answer = () => Response.json(fresh);
    const seen: string[] = [];
    const fetcher = async (request: Request) => {
      seen.push(request.url);
      return answer();
    };
    expect(cache.current()).toBe(EMBEDDED_CATALOG);
    await cache.refresh(fetcher, NOW);
    expect(seen).toEqual([CATALOG_URL]);
    expect(cache.current().claude).toEqual([{ id: "claude-fresh" }]);
    expect(cache.refresh(fetcher, NOW + 3 * 3600 - 1)).toBeNull();
    answer = () => new Response("{", { status: 200 });
    await cache.refresh(fetcher, NOW + 3 * 3600);
    expect(cache.current().claude).toEqual([{ id: "claude-fresh" }]);
    // A failed refresh is tried again sooner.
    expect(cache.refresh(fetcher, NOW + 3 * 3600 + 599)).toBeNull();
    answer = () => new Response("x".repeat(3 * 1024 * 1024));
    await cache.refresh(fetcher, NOW + 3 * 3600 + 600);
    expect(cache.current().claude).toEqual([{ id: "claude-fresh" }]);
    await cache.refresh(async () => Promise.reject(new Error("offline")), NOW + 4 * 3600);
    expect(cache.current().claude).toEqual([{ id: "claude-fresh" }]);
  });

  it("picks a ChatGPT plan's catalog as CPA does", () => {
    expect(codexChannel("free")).toBe("codex-free");
    expect(codexChannel("Plus")).toBe("codex-plus");
    expect(codexChannel("business")).toBe("codex-team");
    expect(codexChannel("pro")).toBe("codex-pro");
    expect(codexChannel("")).toBe("codex-pro");
  });
});
