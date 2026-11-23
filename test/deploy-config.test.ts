import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deployConfig, stripJsonc } from "../scripts/deploy-config.mjs";

const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("deploy-config", () => {
  it("keeps the live install's container app sub2api", () => {
    const config = deployConfig(wrangler);
    expect(config.name).toBe("sub2api");
    expect(config.containers?.map((c) => c.name)).toEqual(["sub2api"]);
    expect(config).toMatchObject({ main: "src/index.ts", r2_buckets: [{ bucket_name: "sub2api" }] });
  });

  it("names the container app after the Worker a Deploy button copy chose", () => {
    const config = deployConfig(wrangler.replace('"name": "sub2api",', '"name": "sub2api-test",'));
    expect(config.name).toBe("sub2api-test");
    expect(config.containers?.[0]?.name).toBe("sub2api-test");
  });

  it("follows the Worker name Workers Builds deploys under", () => {
    const config = deployConfig(wrangler, "sub2api-test");
    expect(config.name).toBe("sub2api-test");
    expect(config.containers?.[0]?.name).toBe("sub2api-test");
  });

  it("reads comments and trailing commas but leaves strings alone", () => {
    const text = '{\n  // note\n  "name": "a//b", /* x */ "url": "http://h/*y*/",\n  "list": [1, 2,],\n  "q": "say \\"hi\\" //",\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ name: "a//b", url: "http://h/*y*/", list: [1, 2], q: 'say "hi" //' });
  });
});
