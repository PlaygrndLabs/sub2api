import { Container } from "@cloudflare/containers";
import type { Env } from "./env.ts";
import { handle } from "./gateway.ts";
import { takeImport } from "./import-config.ts";
import { KeyGuard } from "./key-guard.ts";
import { managementKeyFor } from "./management-key.ts";
import { handleS3 } from "./s3.ts";

export const STATE_HOST = "r2.internal";
export const STATE_BUCKET = "state";

const nowSeconds = () => Math.floor(Date.now() / 1000);
// At most one restart for a rejected management key in this window, so a bad setup can't loop.
const RESTART_SECONDS = 300;

// Every request runs here, in the one Durable Object in front of the container, so a single
// KeyGuard sees every dashboard change no matter which Worker isolate took the request.
export class Cpa extends Container<Env> {
  override defaultPort = 8317;
  override sleepAfter = "30m";
  private readonly keyGuard = new KeyGuard(nowSeconds);
  private managementKey = "";
  private restartedAt = 0;

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      OBJECTSTORE_ENDPOINT: `http://${STATE_HOST}`,
      OBJECTSTORE_BUCKET: STATE_BUCKET,
      OBJECTSTORE_ACCESS_KEY: "r2-binding",
      OBJECTSTORE_SECRET_KEY: "r2-binding",
    };
    // Runs before any request, so the container never starts without its key or a waiting import.
    void ctx.blockConcurrencyWhile(async () => {
      this.managementKey = await managementKeyFor(env.MANAGEMENT_KEY, env.DASHBOARD_PASSWORD);
      this.envVars = { ...this.envVars, CPA_MANAGEMENT_KEY: this.managementKey };
      const imported = await takeImport(env.STATE);
      if (imported !== null) this.envVars = { ...this.envVars, CPA_IMPORT_CONFIG: imported };
    });
  }

  override fetch(request: Request): Promise<Response> {
    return handle(
      request,
      {
        dashboardPassword: this.env.DASHBOARD_PASSWORD ?? "",
        managementKey: this.managementKey,
        keyRejected: () => this.keyRejected(),
        nowSeconds,
        keyGuard: this.keyGuard,
        loginLimiter: this.env.LOGIN_LIMIT,
      },
      (forwarded) => this.containerFetch(forwarded),
    );
  }

  // CPA refused the key the gateway sent: it still runs with an older key (a secret changed while
  // it was up). Stopping it makes the next request start it with the current key.
  private async keyRejected(): Promise<boolean> {
    const now = nowSeconds();
    if (now - this.restartedAt < RESTART_SECONDS) return false;
    this.restartedAt = now;
    await this.stop().catch(() => undefined);
    return true;
  }
}

Cpa.outboundByHost = {
  [STATE_HOST]: (request, env) => handleS3(request, (env as Env).STATE, STATE_BUCKET),
};
