/**
 * Database connection utilities for better-sqlite3
 */

import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

export function openDatabase(path: string): Database {
  try {
    return new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(`Failed to open database at ${path}: ${(err as Error).message}`);
  }
}

export function closeDatabase(db: Database): void {
  try {
    db.close();
  } catch (err) {
    console.error(`Error closing database: ${(err as Error).message}`);
  }
}

export function queryAll<T>(db: Database, sql: string): Array<T> {
  try {
    return db.prepare(sql).all() as Array<T>;
  } catch (err) {
    throw new Error(`Query failed: ${(err as Error).message}\nSQL: ${sql}`);
  }
}

export function queryAllWithParams<T, TParams extends Array<unknown> = Array<unknown>>(
  db: Database,
  sql: string,
  ...params: TParams
): Array<T> {
  try {
    return db.prepare(sql).all(...params) as Array<T>;
  } catch (err) {
    throw new Error(
      `Query with params failed: ${(err as Error).message}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`,
    );
  }
}
