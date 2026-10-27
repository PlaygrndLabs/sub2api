import { DurableObject } from "cloudflare:workers";
import { Account, type Backend, type Overview, type TokenResult } from "./account.ts";
import type { Env } from "./env.ts";
import { Vault } from "./vault.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);

// The one Durable Object holding API keys and the Claude login in its SQLite storage
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
  invalidate(accessToken: string): Promise<void> {
    return this.account.invalidate(accessToken);
  }
  overview(): Promise<Overview> {
    return this.account.overview();
  }
  createKey(name: string): Promise<string> {
    return this.account.createKey(name);
  }
  revokeKey(id: number): Promise<void> {
    return this.account.revokeKey(id);
  }
  startLogin(): Promise<string> {
    return this.account.startLogin();
  }
  finishLogin(callback: string): Promise<string | null> {
    return this.account.finishLogin(callback);
  }
  disconnect(): Promise<void> {
    return this.account.disconnect();
  }
  attemptAllowed(client: string): Promise<boolean> {
    return this.account.attemptAllowed(client);
  }
}
