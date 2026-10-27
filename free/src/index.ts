import { EdgeCache, handle } from "./app.ts";
import type { Env } from "./env.ts";

export { Store } from "./store.ts";

const cache = new EdgeCache();
const nowSeconds = () => Math.floor(Date.now() / 1000);

export default {
  fetch(request, env) {
    return handle(request, {
      backend: env.STORE.getByName("main"),
      dashboardPassword: env.DASHBOARD_PASSWORD ?? "",
      managementKey: env.MANAGEMENT_KEY ?? "",
      nowSeconds,
      upstream: (upstream) => fetch(upstream),
      panel: (panelRequest) => env.ASSETS.fetch(new Request(new URL("/management.html", panelRequest.url))),
      cache,
    });
  },
} satisfies ExportedHandler<Env>;
