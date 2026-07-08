/**
 * Database connection + one-time schema init.
 *
 * Uses Node's built-in `node:sqlite` (stable in Node 22+), so there's no native
 * module to compile — zero install/build friction. The `db()` accessor returns a
 * thin wrapper whose `prepare()` enables bare named parameters, so repositories can
 * bind with plain object keys (`{ id }`) against `@id`-style placeholders.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config/index.js";

let _raw: DatabaseSync | null = null;

function raw(): DatabaseSync {
  if (_raw) return _raw;
  const path = resolve(process.cwd(), config.env.databasePath);
  mkdirSync(dirname(path), { recursive: true });
  _raw = new DatabaseSync(path);
  _raw.exec("PRAGMA journal_mode = WAL;");
  _raw.exec("PRAGMA foreign_keys = ON;");
  return _raw;
}

export interface Db {
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
}

export function db(): Db {
  const r = raw();
  return {
    prepare(sql: string): StatementSync {
      const stmt = r.prepare(sql);
      // Allow `{ id }` instead of `{ "@id" }` when binding named parameters.
      stmt.setAllowBareNamedParameters(true);
      return stmt;
    },
    exec: (sql: string) => r.exec(sql),
  };
}

/** Run the DDL. Idempotent (all statements are IF NOT EXISTS). */
export function initSchema(): void {
  const sql = readFileSync(resolve(import.meta.dirname, "schema.sql"), "utf8");
  db().exec(sql);
}
