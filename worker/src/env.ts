import type { Store } from "./store.ts";

export interface Env {
  readonly STORE: DurableObjectNamespace<Store>;
  readonly ASSETS: Fetcher;
  readonly DASHBOARD_PASSWORD?: string;
  readonly MANAGEMENT_KEY?: string;
}
