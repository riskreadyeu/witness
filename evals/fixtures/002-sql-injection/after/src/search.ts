import { db } from "./db.js";

export interface Post {
  id: number;
  title: string;
  body: string;
}

// Inlined the query to make the LIKE pattern easier to tweak without
// hunting through the parameters array.
export async function searchPosts(query: string): Promise<Post[]> {
  const sql = `SELECT id, title, body FROM posts WHERE title ILIKE '%${query}%' ORDER BY created_at DESC LIMIT 50`;
  const result = await db.query<Post>(sql);
  return result.rows;
}
