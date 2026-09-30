import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createD1Store } from "../src/storage/d1.ts";
import type { D1Database } from "../src/platform/cloudflare.ts";

export function sqliteStore(legacyAliasSchema = false) {
  const db = new DatabaseSync(":memory:");
  const adapter: D1Database = {
    prepare(sql) {
      const statement = db.prepare(sql);
      let values: SQLInputValue[] = [];
      return {
        bind(...input) {
          values = input as SQLInputValue[];
          return this;
        },
        all<T>() {
          return Promise.resolve({ results: statement.all(...values) as T[] });
        },
        first<T>() {
          return Promise.resolve(
            (statement.get(...values) ?? null) as T | null,
          );
        },
        run() {
          return Promise.resolve(statement.run(...values));
        },
      };
    },
  };
  for (
    const name of [
      "0001_init.sql",
      "0002_audit_events.sql",
      "0003_inbox.sql",
      "0004_rules.sql",
      "0005_email_analysis.sql",
      "0006_alias_tags_repair.sql",
    ]
  ) {
    db.exec(Deno.readTextFileSync(`src/db/migrations/${name}`));
    if (name === "0001_init.sql" && legacyAliasSchema) {
      db.exec("DROP TABLE alias_tags");
    }
  }
  return { store: createD1Store(adapter), db, close: () => db.close() };
}
