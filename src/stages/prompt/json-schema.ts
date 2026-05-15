/**
 * JSON-schema rendering of ReviewResponseSchema for the SDK's
 * `outputFormat: { type: 'json_schema' }` constraint.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { ReviewResponseSchema } from "./schema.js";

const raw = zodToJsonSchema(ReviewResponseSchema, {
  name: "PromptReviewResponse",
  $refStrategy: "none",
});

function inlineRoot(s: Record<string, unknown>): Record<string, unknown> {
  if (typeof s["$ref"] === "string" && s["definitions"]) {
    const ref = s["$ref"] as string;
    const name = ref.replace(/^#\/definitions\//, "");
    const defs = s["definitions"] as Record<string, Record<string, unknown>>;
    const target = defs[name];
    if (target) return target;
  }
  return s;
}

export const reviewResponseJsonSchema = inlineRoot(raw as Record<string, unknown>);
