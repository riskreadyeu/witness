/**
 * Diagnostic: run a single Claude Agent SDK sample on fixture 001 and
 * print every message the agent emits. Used to diagnose why otherwise
 * trivial fixtures are hitting `error_max_turns`.
 *
 * Run with:  pnpm tsx evals/debug-one.ts
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { buildContext, renderUserMessage } from "../src/diff.js";
import { reviewResponseJsonSchema } from "../src/json-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, "fixtures/public/001-missing-await");

async function tryLoad(): Promise<{ diff: string; afterDir: string }> {
  for (const candidate of [
    join(__dirname, "fixtures/public/001-missing-await"),
    join(__dirname, "fixtures/001-missing-await"),
  ]) {
    try {
      const diff = await readFile(join(candidate, "diff.patch"), "utf-8");
      return { diff, afterDir: join(candidate, "after") };
    } catch {
      /* try next */
    }
  }
  throw new Error("fixture not found");
}

async function main(): Promise<void> {
  const { diff, afterDir } = await tryLoad();
  const ctx = buildContext({ diff, repoRoot: afterDir });
  const prompt = renderUserMessage(ctx);

  const options: Options = {
    model: "claude-sonnet-4-5-20250929",
    cwd: afterDir,
    systemPrompt: SYSTEM_PROMPT,
    tools: ["Read", "Grep", "Glob"],
    allowedTools: ["Read", "Grep", "Glob"],
    permissionMode: "default",
    settingSources: [],
    persistSession: false,
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    outputFormat: {
      type: "json_schema",
      schema: reviewResponseJsonSchema as Record<string, unknown>,
    },
  };

  console.log(`afterDir = ${afterDir}`);
  console.log(`diff bytes = ${diff.length}`);
  console.log(`prompt bytes = ${prompt.length}`);
  console.log("─".repeat(60));

  let turn = 0;
  for await (const msg of query({ prompt, options })) {
    turn++;
    const summary: Record<string, unknown> = { type: msg.type };
    if ("subtype" in msg) summary["subtype"] = (msg as { subtype?: unknown }).subtype;
    // Surface the fields that matter for diagnosis without drowning in JSON.
    if (msg.type === "assistant" || msg.type === "user") {
      const m = msg as unknown as { message?: { content?: unknown } };
      const content = m.message?.content;
      if (Array.isArray(content)) {
        summary["content"] = content.map((c: unknown) => {
          if (typeof c !== "object" || c === null) return c;
          const block = c as Record<string, unknown>;
          const t = block["type"];
          if (t === "text") {
            const text = typeof block["text"] === "string" ? block["text"] : "";
            return { type: "text", preview: text.slice(0, 300) };
          }
          if (t === "tool_use") {
            return {
              type: "tool_use",
              name: block["name"],
              input: block["input"],
            };
          }
          if (t === "tool_result") {
            const r = block["content"];
            const preview = typeof r === "string" ? r.slice(0, 200) : r;
            return { type: "tool_result", preview, is_error: block["is_error"] };
          }
          return { type: t };
        });
      }
    }
    if (msg.type === "result") {
      const r = msg as unknown as Record<string, unknown>;
      summary["total_cost_usd"] = r["total_cost_usd"];
      summary["num_turns"] = r["num_turns"];
      summary["errors"] = r["errors"];
      summary["structured_output"] = r["structured_output"];
      summary["result_preview"] =
        typeof r["result"] === "string" ? (r["result"] as string).slice(0, 500) : undefined;
    }
    console.log(`\n[${turn}] ${JSON.stringify(summary, null, 2)}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
