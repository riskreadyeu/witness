import { pool } from "./db.js";

export async function searchUsers(query: string): Promise<unknown[]> {
  const result = await pool.query(
    `SELECT id, name FROM users WHERE name ILIKE '%${query}%' LIMIT 50`,
  );
  return result.rows;
}
