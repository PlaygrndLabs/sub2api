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
      nowSeconds,
      upstream: (upstream) => fetch(upstream),
      cache,
    });
  },
} satisfies ExportedHandler<Env>;
