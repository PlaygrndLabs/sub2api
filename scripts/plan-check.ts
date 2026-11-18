// Stops a Container deploy early, with a plain message, on a Cloudflare account that can't run
// Containers. Containers come only with the Workers Paid plan. Without this check a deploy on
// Workers Free uploads the Worker and creates the R2 bucket, then fails at the container step
// with a bare "Unauthorized", and the gateway URL answers 404.
// `npm run deploy` runs it before `wrangler deploy`; that is the deploy command the Deploy to
// Cloudflare button sets up. It asks Cloudflare with wrangler's own login and prints no secrets.
//   node scripts/plan-check.ts          SUB2API_SKIP_PLAN_CHECK=1 skips it
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PlanCheck = "ok" | "needs-paid" | "unknown";

const NEEDS_PAID = /do not have access to Cloudflare Containers|requires the Workers Paid plan/i;

// Reads the output of `wrangler containers list`.
export function classify(output: string, exitCode: number | null): PlanCheck {
  if (NEEDS_PAID.test(output)) return "needs-paid";
  return exitCode === 0 ? "ok" : "unknown";
}

export const NEEDS_PAID_MESSAGE = `
✘ sub2api needs the Cloudflare Workers Paid plan. This build deployed nothing.

  sub2api runs CPA in a Cloudflare Container, and Containers come only with
  Workers Paid ($5/month). This Cloudflare account is on Workers Free.

  To fix it, pick one:
  1. Upgrade to Workers Paid: https://dash.cloudflare.com/?to=/:account/workers/plans
     Then deploy again: Workers & Pages → your Worker → Deployments → Retry build,
     or push a commit to the repository.
  2. Stay on Workers Free with the Workers-only install (beta):
     https://github.com/PlaygrndLabs/sub2api#workers-only-install-beta
`;

// Drops terminal colour codes from wrangler's output.
function plain(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function main(): number {
  if (process.env.SUB2API_SKIP_PLAN_CHECK === "1") {
    console.log("Plan check skipped (SUB2API_SKIP_PLAN_CHECK=1).");
    return 0;
  }
  const run = spawnSync("npx", ["--no-install", "wrangler", "containers", "list"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = plain(`${run.stdout ?? ""}\n${run.stderr ?? ""}`);
  switch (classify(output, run.status)) {
    case "ok":
      console.log("Plan check: this account can run Cloudflare Containers.");
      return 0;
    case "needs-paid":
      console.error(NEEDS_PAID_MESSAGE);
      return 1;
    case "unknown": {
      // Any other failure is left to `wrangler deploy`, which reports it in full.
      const line = output.split("\n").find((l) => /ERROR|✘/.test(l))?.trim() ?? `exit code ${run.status}`;
      console.warn(`Plan check could not confirm Containers access (${line}). Deploying anyway.`);
      return 0;
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
