import { describe, expect, it } from "vitest";
import { classify } from "../scripts/plan-check.ts";

// The error wrangler 4 prints for `wrangler containers list` on a Workers Free account.
const FREE_PLAN_OUTPUT = `✘ [ERROR] There has been an unknown error listing containers.
  {"error":"{\\"error\\":\\"Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan. Upgrade your plan at https://dash.cloudflare.com/?to=/:account/workers/plans\\"}"}`;

describe("plan check", () => {
  it("stops on a Workers Free account", () => {
    expect(classify(FREE_PLAN_OUTPUT, 1)).toBe("needs-paid");
  });

  it("passes when the account can list containers", () => {
    expect(classify("No containers found.", 0)).toBe("ok");
  });

  it("leaves other failures to wrangler deploy", () => {
    expect(classify("✘ [ERROR] Authentication error [code: 10000]", 1)).toBe("unknown");
    expect(classify("", null)).toBe("unknown");
  });
});
