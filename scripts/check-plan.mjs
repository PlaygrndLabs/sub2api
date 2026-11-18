// Runs before `wrangler deploy` in `npm run deploy`, the deploy command the Deploy to Cloudflare
// button uses. The Container install needs Cloudflare Containers, which only the Workers Paid plan
// has. On Workers Free, wrangler would upload the Worker first and then fail at the container step,
// leaving a Worker with no address and a vague error. So ask first and stop with a clear message.
// Any other answer (paid plan, no login yet, network trouble) lets the deploy go on as before.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PAID_PLAN_NEEDED = `
✘ sub2api: this is the Container install. It needs Cloudflare Containers, and Containers need
  the Workers Paid plan ($5/month, paid to Cloudflare). This account is on Workers Free.

  Nothing was deployed. Pick one:
  1. Upgrade to Workers Paid in the Cloudflare dashboard (Workers & Pages, then Plans),
     then retry this build.
  2. Use the Workers-only install (beta), which runs on Workers Free:
     https://deploy.workers.cloudflare.com/?url=https://github.com/PlaygrndLabs/sub2api/tree/main/worker
`;

export function needsPaidPlan(output) {
  return /Workers Paid plan|do not have access to Cloudflare Containers/i.test(output);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const result = existsSync(wrangler) ? spawnSync(process.execPath, [wrangler, "containers", "list"], { encoding: "utf8", timeout: 60_000 }) : {};
  if (needsPaidPlan(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) {
    console.error(PAID_PLAN_NEEDED);
    process.exit(1);
  }
}
