/**
 * Convert Oracle's Zod schema to a JSON Schema for the Claude Agent SDK's
 * `outputFormat: { type: 'json_schema', schema }` option.
 *
 * The SDK will auto-retry the model up to N times if the output doesn't
 * validate. That means the model can be wrong and still recover without
 * us writing a regex parser — exactly the leverage we want.
 *
 * We strip `$schema` and `$ref` indirection and produce a single inline
 * object so the transport doesn't need to resolve external references.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { ReviewResponseSchema } from "./schema.js";

export const reviewResponseJsonSchema = zodToJsonSchema(ReviewResponseSchema, {
  name: "ReviewResponse",
  $refStrategy: "none",
  target: "jsonSchema7",
});
