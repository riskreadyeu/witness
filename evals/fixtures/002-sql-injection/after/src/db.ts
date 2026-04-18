/**
 * Thin wrapper around node-postgres. Exported as a singleton so callers
 * don't have to pass a pool around.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export const db: Db = {
  async query() {
    throw new Error("db.query stub — wire up in production");
  },
};
