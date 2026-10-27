import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../src/vault.ts";

export function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}
