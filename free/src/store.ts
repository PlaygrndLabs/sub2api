import { DurableObject } from "cloudflare:workers";
import { Account, type Backend, type ServedLogin, type TokenResult } from "./account.ts";
import type { Env } from "./env.ts";
import { handleManagement } from "./management.ts";
import type { RoutingTable } from "./providers.ts";
import type { UsageRecord } from "./usage.ts";
import { Vault } from "./vault.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);

// The one Durable Object holding the config, API keys and provider logins in its SQLite storage
// (SQLite-backed Durable Objects are part of the Workers Free plan).
export class Store extends DurableObject<Env> implements Backend {
  private readonly account: Account;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.account = new Account(new Vault(ctx.storage.sql), (request) => fetch(request), nowSeconds);
  }

  keyValid(hash: string): Promise<boolean> {
    return this.account.keyValid(hash);
  }
  token(): Promise<TokenResult> {
    return this.account.token();
  }
  codexToken(): Promise<TokenResult> {
    return this.account.codexToken();
  }
  loginToken(provider: ServedLogin): Promise<TokenResult> {
    return this.account.loginToken(provider);
  }
  invalidate(accessToken: string): Promise<void> {
    return this.account.invalidate(accessToken);
  }
  attemptAllowed(client: string): Promise<boolean> {
    return this.account.attemptAllowed(client);
  }
  manage(request: Request): Promise<Response> {
    return handleManagement(request, this.account);
  }
  routing(): Promise<RoutingTable> {
    return this.account.routing();
  }
  record(records: UsageRecord[]): Promise<void> {
    return this.account.record(records);
  }
}
