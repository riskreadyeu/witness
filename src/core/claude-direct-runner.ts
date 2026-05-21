/**
 * Claude-direct runner.
 *
 * Bypasses @anthropic-ai/claude-agent-sdk and calls @anthropic-ai/sdk
 * directly so we can set `cache_control: { type: "ephemeral" }` on the
 * system prompt and the initial user-message artifact block. All N
 * samples send the IDENTICAL prefix — sample 1 writes the cache,
 * samples 2..N read it at 10% of input price.
 *
 * Structured output: we add a `submit_findings` tool whose input_schema
 * is the stage's Zod-derived JSON schema. The model "calls" this tool
 * with its findings when ready. We capture the tool input as the
 * structured output. Cleaner than parsing JSON from end-turn text.
 *
 * Tools: Read, Grep, Glob — implemented locally via fs / grep / find.
 * Path-escape guard: every tool path is resolved under repoRoot.
 *
 * Auth: pulls OAuth bearer from ~/.claude/.credentials.json when
 * ANTHROPIC_API_KEY is not set. The bearer hits api.anthropic.com
 * directly (verified by the cache probe).
 *
 * Pricing (Opus 4.7): input $15/M, cache_write $18.75/M, cache_read
 * $1.50/M, output $75/M. Pricing is hard-coded for Opus today; revisit
 * if other models become defaults.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ReviewRunner, RunnerOptions, RunResult, SampleResult } from "./runner-types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export type DirectRunOptions = RunnerOptions;
interface _DirectRunOptionsLegacy {
  systemPrompt: string;
  userMessage: string;
  repoRoot: string;
  outputSchema: Record<string, unknown>;
  tools: string[];
  model: string;
  maxTurnsPerSample: number;
  maxBudgetUsdPerSample: number;
  samples: number;
}

export type DirectSampleResult = SampleResult;
interface _DirectSampleResultLegacy {
  structuredOutput: unknown | null;
  costUsd: number;
  turns: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  errorReason?: string;
}

export type DirectRunResult = RunResult;
interface _DirectRunResultLegacy {
  samples: DirectSampleResult[];
  totalCostUsd: number;
  totalTurns: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
}

interface ModelPricing {
  inputPerM: number;
  cacheWritePerM: number;
  cacheReadPerM: number;
  outputPerM: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Opus 4.7 — verified Anthropic public pricing
  'claude-opus-4-7':           { inputPerM: 15.0,  cacheWritePerM: 18.75,  cacheReadPerM: 1.50, outputPerM: 75.0 },
  // Sonnet 4.6
  'claude-sonnet-4-6':         { inputPerM:  3.0,  cacheWritePerM:  3.75,  cacheReadPerM: 0.30, outputPerM: 15.0 },
  // Haiku 4.5
  'claude-haiku-4-5-20251001': { inputPerM:  1.0,  cacheWritePerM:  1.25,  cacheReadPerM: 0.10, outputPerM:  5.0 },
  // Fallback (conservative — Opus rates) for unknown model strings
  default:                     { inputPerM: 15.0,  cacheWritePerM: 18.75,  cacheReadPerM: 1.50, outputPerM: 75.0 },
};

function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? PRICING.default!;
}

function costOf(
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
  model: string,
): number {
  const p = pricingFor(model);
  return (
    (usage.input_tokens / 1e6) * p.inputPerM +
    ((usage.cache_creation_input_tokens ?? 0) / 1e6) * p.cacheWritePerM +
    ((usage.cache_read_input_tokens ?? 0) / 1e6) * p.cacheReadPerM +
    (usage.output_tokens / 1e6) * p.outputPerM
  );
}

export function resolveAuth(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  const parsed = JSON.parse(readFileSync(credsPath, "utf8")) as {
    claudeAiOauth?: { accessToken?: string };
  };
  if (!parsed.claudeAiOauth?.accessToken) {
    throw new Error("no auth: set ANTHROPIC_API_KEY or run `claude login`");
  }
  return parsed.claudeAiOauth.accessToken;
}

export async function runSamples(opts: DirectRunOptions): Promise<DirectRunResult> {
  const client = new Anthropic({ apiKey: resolveAuth() });
  const samples = await Promise.all(
    Array.from({ length: opts.samples }, () => runOneSample(client, opts)),
  );
  return {
    samples,
    totalCostUsd: samples.reduce((a, s) => a + s.costUsd, 0),
    totalTurns: samples.reduce((a, s) => a + s.turns, 0),
    totalCacheCreationTokens: samples.reduce((a, s) => a + s.cacheCreationTokens, 0),
    totalCacheReadTokens: samples.reduce((a, s) => a + s.cacheReadTokens, 0),
    provider: "anthropic",
  };
}

/**
 * Class-form wrapper that satisfies ReviewRunner. The dispatcher uses this;
 * the functional runSamples export above is kept for direct callers (spec stage,
 * pre-dispatcher tests).
 */
export class ClaudeDirectRunner implements ReviewRunner {
  async runSamples(opts: RunnerOptions): Promise<RunResult> {
    return runSamples(opts);
  }
}

async function runOneSample(
  client: Anthropic,
  opts: DirectRunOptions,
): Promise<DirectSampleResult> {
  const tools = buildToolList(opts.tools, opts.outputSchema);

  // Initial user message with cache_control on the artifact block.
  // The system prompt is also marked cached — together they form the
  // prefix that subsequent samples will read from cache.
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: opts.userMessage,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ];

  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: "text",
      text: opts.systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];

  let totalCost = 0;
  let totalTurns = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  while (totalTurns < opts.maxTurnsPerSample) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: opts.model,
        max_tokens: 4096,
        system: systemBlocks,
        messages,
        tools,
        tool_choice: { type: "auto" },
      });
    } catch (err) {
      return {
        structuredOutput: null,
        costUsd: totalCost,
        turns: totalTurns,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        errorReason: `api_error: ${(err as Error).message}`,
      };
    }

    totalCost += costOf(response.usage, opts.model);
    totalTurns++;
    cacheCreation += response.usage.cache_creation_input_tokens ?? 0;
    cacheRead += response.usage.cache_read_input_tokens ?? 0;

    if (totalCost >= opts.maxBudgetUsdPerSample) {
      return {
        structuredOutput: null,
        costUsd: totalCost,
        turns: totalTurns,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        errorReason: "max_budget_exceeded",
      };
    }

    // Look for submit_findings — that's the structured-output signal
    const submitCall = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === "submit_findings",
    );
    if (submitCall) {
      return {
        structuredOutput: submitCall.input,
        costUsd: totalCost,
        turns: totalTurns,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
      };
    }

    if (response.stop_reason === "end_turn") {
      // Model finished without calling submit_findings — try to extract from last text block
      const textBlock = response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      );
      let parsed: unknown = null;
      if (textBlock) {
        try {
          const t = textBlock.text.trim();
          const start = t.indexOf("{");
          const end = t.lastIndexOf("}");
          if (start !== -1 && end > start) parsed = JSON.parse(t.slice(start, end + 1));
        } catch {
          /* fall through */
        }
      }
      return {
        structuredOutput: parsed,
        costUsd: totalCost,
        turns: totalTurns,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        ...(parsed === null ? { errorReason: "end_turn_without_submit_findings" } : {}),
      };
    }

    // Execute tools, append assistant message + tool_result, loop
    messages.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "submit_findings") continue;
      try {
        const result = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          opts.repoRoot,
        );
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }
    if (toolResults.length === 0) {
      // Defensive: model returned no tool_use and no end_turn — shouldn't happen
      return {
        structuredOutput: null,
        costUsd: totalCost,
        turns: totalTurns,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        errorReason: `unexpected stop_reason: ${response.stop_reason}`,
      };
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    structuredOutput: null,
    costUsd: totalCost,
    turns: totalTurns,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    errorReason: "max_turns_reached",
  };
}

function buildToolList(
  enabled: string[],
  outputSchema: Record<string, unknown>,
): Anthropic.Messages.Tool[] {
  const list: Anthropic.Messages.Tool[] = [];
  if (enabled.includes("Read")) list.push(READ_TOOL);
  if (enabled.includes("Grep")) list.push(GREP_TOOL);
  if (enabled.includes("Glob")) list.push(GLOB_TOOL);
  list.push(makeSubmitFindingsTool(outputSchema));
  return list;
}

const READ_TOOL: Anthropic.Messages.Tool = {
  name: "Read",
  description:
    "Read the full contents of a file. Path is relative to the repo root the reviewer is anchored at. Use to verify cross-references and inspect cited files.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to repoRoot" },
    },
    required: ["path"],
  },
};

const GREP_TOOL: Anthropic.Messages.Tool = {
  name: "Grep",
  description:
    "Search for a regex pattern across files in the repo using grep. Returns matching lines with file:line prefix. Use to verify whether a symbol/file/term actually exists.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: {
        type: "string",
        description: "Optional subdirectory (relative to repoRoot) to limit the search",
      },
    },
    required: ["pattern"],
  },
};

const GLOB_TOOL: Anthropic.Messages.Tool = {
  name: "Glob",
  description: "List file paths matching a glob pattern under the repo root.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern, e.g. '*.yaml', 'Dockerfile', 'src/**/*.ts'",
      },
    },
    required: ["pattern"],
  },
};

function makeSubmitFindingsTool(
  schema: Record<string, unknown>,
): Anthropic.Messages.Tool {
  return {
    name: "submit_findings",
    description:
      "Submit your structured findings as the FINAL action of this review. Call this exactly once, when you have completed all the investigation you intend to do. After calling submit_findings, do not make further tool calls.",
    input_schema: schema as Anthropic.Messages.Tool.InputSchema,
  };
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  repoRoot: string,
): Promise<string> {
  if (name === "Read") {
    const path = String(input.path ?? "");
    if (!path) throw new Error("Read: path required");
    const abs = resolveSafePath(repoRoot, path);
    const content = await readFileAsync(abs, "utf8");
    const CAP = 50_000;
    if (content.length > CAP) {
      return content.slice(0, CAP) + `\n... [truncated; full size ${content.length} chars]`;
    }
    return content;
  }
  if (name === "Grep") {
    const pattern = String(input.pattern ?? "");
    if (!pattern) throw new Error("Grep: pattern required");
    const targetSub = String(input.path ?? "");
    const target = targetSub ? resolveSafePath(repoRoot, targetSub) : repoRoot;
    try {
      const { stdout } = await execFileAsync(
        "grep",
        ["-rn", "--max-count=200", "-E", pattern, target],
        { maxBuffer: 200_000 },
      );
      return stdout.length > 20_000
        ? stdout.slice(0, 20_000) + "\n... [grep output truncated]"
        : stdout || "(no matches)";
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 1) return "(no matches)";
      throw err;
    }
  }
  if (name === "Glob") {
    const pattern = String(input.pattern ?? "");
    if (!pattern) throw new Error("Glob: pattern required");
    // Strip leading directory crumbs we can't safely pass to find -name
    const nameOnly = pattern.includes("/") ? pattern.split("/").pop() ?? pattern : pattern;
    try {
      const { stdout } = await execFileAsync(
        "find",
        [repoRoot, "-type", "f", "-name", nameOnly, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"],
        { maxBuffer: 200_000 },
      );
      return stdout.length > 20_000
        ? stdout.slice(0, 20_000) + "\n... [glob output truncated]"
        : stdout || "(no matches)";
    } catch (err) {
      throw new Error(`Glob failed: ${(err as Error).message}`);
    }
  }
  throw new Error(`unknown tool: ${name}`);
}

function resolveSafePath(repoRoot: string, p: string): string {
  const root = resolve(repoRoot);
  const abs = isAbsolute(p) ? p : resolve(root, p);
  if (!abs.startsWith(root)) {
    throw new Error(`path escapes repoRoot: ${p}`);
  }
  return abs;
}
