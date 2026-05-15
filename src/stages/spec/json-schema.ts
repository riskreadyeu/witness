/**
 * JSON-schema rendering of ReviewResponseSchema for the SDK's
 * `outputFormat: { type: 'json_schema' }` constraint.
 *
 * We use zod-to-json-schema and then inline the root $ref because
 * Anthropic's structured-output validator doesn't like top-level refs.
 * (Same workaround Witness uses; see witness src/json-schema.ts.)
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { ReviewResponseSchema } from "./schema.js";

const raw = zodToJsonSchema(ReviewResponseSchema, {
  name: "ReviewResponse",
  $refStrategy: "none",
});

// Some versions of zod-to-json-schema wrap in { definitions, $ref } even
// with $refStrategy: 'none'. Unwrap defensively.
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
