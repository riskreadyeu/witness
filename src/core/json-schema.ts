/**
 * Convert Witness's Zod schema to a JSON Schema for the Claude Agent SDK's
 * `outputFormat: { type: 'json_schema', schema }` option.
 *
 * The SDK will auto-retry the model up to N times if the output doesn't
 * validate. That means the model can be wrong and still recover without
 * us writing a regex parser — exactly the leverage we want.
 *
 * Gotcha: zod-to-json-schema with `name` wraps the root in
 * `{ $ref: "#/definitions/Name", definitions: { Name: {...} } }`.
 * The Anthropic tool-use API treats this schema as a tool's
 * `input_schema` and requires `type: "object"` at the root — a pure
 * `$ref` root is rejected with `tools.N.custom.input_schema.type:
 * Field required`. So we inline the top-level ref and drop the
 * definitions wrapper before handing it to the SDK.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { ReviewResponseSchema } from "./schema.js";

function inlineRootRef(schema: Record<string, unknown>): Record<string, unknown> {
  const ref = schema["$ref"];
  const defs = schema["definitions"];
  if (typeof ref !== "string" || !defs || typeof defs !== "object") return schema;
  const match = ref.match(/^#\/definitions\/(.+)$/);
  if (!match) return schema;
  const name = match[1]!;
  const definition = (defs as Record<string, unknown>)[name];
  if (!definition || typeof definition !== "object") return schema;
  // Return the definition itself. We deliberately drop `definitions` and
  // `$schema` — anything we needed from them was pulled in via the
  // `$refStrategy: "none"` option, which inlines internal refs.
  return definition as Record<string, unknown>;
}

const raw = zodToJsonSchema(ReviewResponseSchema, {
  name: "ReviewResponse",
  $refStrategy: "none",
  target: "jsonSchema7",
}) as Record<string, unknown>;

export const reviewResponseJsonSchema = inlineRootRef(raw);
