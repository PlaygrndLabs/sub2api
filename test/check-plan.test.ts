import { describe, expect, it } from "vitest";
import { PAID_PLAN_NEEDED, needsPaidPlan } from "../scripts/check-plan.mjs";

describe("check-plan", () => {
  it("stops on the answer Cloudflare gives a Workers Free account", () => {
    const free = "✘ [ERROR] Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan.";
    expect(needsPaidPlan(free)).toBe(true);
    expect(PAID_PLAN_NEEDED).toContain("Workers-only install");
  });

  it("lets the deploy go on for any other answer", () => {
    expect(needsPaidPlan("")).toBe(false);
    expect(needsPaidPlan("No containers found.")).toBe(false);
    expect(needsPaidPlan("✘ [ERROR] In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable")).toBe(false);
  });
});
