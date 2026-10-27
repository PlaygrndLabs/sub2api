import type { Store } from "./store.ts";

export interface Env {
  readonly STORE: DurableObjectNamespace<Store>;
  readonly DASHBOARD_PASSWORD?: string;
}
