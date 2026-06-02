/**
 * Gemini runner — Google Generative AI via @google/genai.
 *
 * Mirrors claude-direct-runner.ts: N parallel samples, manual tool-use
 * loop (Gemini calls it functionCalling), submit_findings tool for
 * structured output, repoRoot-escape-guarded local tool executors.
 *
 * Caching: Gemini's context cache is an explicit object (CachedContent)
 * created once via ai.caches.create() and referenced by all N samples
 * via config.cachedContent. We create it lazily on the first sample's
 * request and reuse for samples 2..N within the run.
 *
 * Auth: pulls GEMINI_API_KEY from env (the typical aistudio.google.com
 * key). The OAuth bearer in ~/.gemini/oauth_creds.json is cloud-platform
 * scope (Vertex AI) — different SDK path, not supported here. If you
 * only have the gemini-cli OAuth, get an aistudio key from
 * https://aistudio.google.com/apikey and `export GEMINI_API_KEY=...`.
 *
 * Pricing (Gemini 2.5 — Anthropic-style per-million-tokens):
 *   Pro <=200k input  : $1.25/M in, $10.00/M out
 *   Pro >200k input   : $2.50/M in, $15.00/M out
 *   Flash             : $0.30/M in, $2.50/M out
 *   Cached input read : 0.25x of input rate (rough — varies by tier)
 */

import { GoogleGenAI, Type, FunctionCallingConfigMode, type Content, type FunctionDeclaration, type Tool, type Part } from "@google/genai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile as readFileAsync } from "node:fs/promises";
import { resolveSafePath } from "./path-guard.js";
import type { ReviewRunner, RunnerOptions, RunResult, SampleResult } from "./runner-types.js";

const execFileAsync = promisify(execFile);

interface ModelPricing {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

// Conservative — assumes <=200k input tier. If a stage routinely exceeds
// 200k tokens, the displayed cost will under-report by ~2x; switch to
// the high tier when measured input exceeds 200k.
const PRICING: Record<string, ModelPricing> = {
  "gemini-2.5-pro":     { inputPerM: 1.25, cachedInputPerM: 0.31, outputPerM: 10.0 },
  "gemini-2.5-flash":   { inputPerM: 0.30, cachedInputPerM: 0.075, outputPerM: 2.50 },
  "gemini-2.0-flash":   { inputPerM: 0.10, cachedInputPerM: 0.025, outputPerM: 0.40 },
  default:              { inputPerM: 1.25, cachedInputPerM: 0.31, outputPerM: 10.0 },
};

function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? PRICING.default!;
}

function costOf(
  usageMetadata:
    | {
        promptTokenCount?: number | null;
        cachedContentTokenCount?: number | null;
        candidatesTokenCount?: number | null;
      }
    | undefined,
  model: string,
): { cost: number; cacheReadTokens: number } {
  if (!usageMetadata) return { cost: 0, cacheReadTokens: 0 };
  const p = pricingFor(model);
  const cached = usageMetadata.cachedContentTokenCount ?? 0;
  const promptTotal = usageMetadata.promptTokenCount ?? 0;
  const nonCachedInput = Math.max(0, promptTotal - cached);
  const output = usageMetadata.candidatesTokenCount ?? 0;
  const cost =
    (nonCachedInput / 1e6) * p.inputPerM +
    (cached / 1e6) * p.cachedInputPerM +
    (output / 1e6) * p.outputPerM;
  return { cost, cacheReadTokens: cached };
}

export function resolveAuth(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  throw new Error(
    "no Gemini auth: set GEMINI_API_KEY (from https://aistudio.google.com/apikey). " +
      "The gemini-cli OAuth in ~/.gemini/oauth_creds.json is Vertex AI scope — not supported by this runner.",
  );
}

export class GeminiRunner implements ReviewRunner {
  async runSamples(opts: RunnerOptions): Promise<RunResult> {
    const ai = new GoogleGenAI({ apiKey: resolveAuth() });

    // Try to create a shared CachedContent for samples 2..N.
    // Minimum size for caching varies (~32K tokens for some Gemini models);
    // if creation fails (e.g., too small), fall back to no-cache mode and
    // each sample sends the prefix fresh.
    let cachedContentName: string | null = null;
    let cacheCreationTokens = 0;
    try {
      const cache = await ai.caches.create({
        model: opts.model,
        config: {
          systemInstruction: opts.systemPrompt,
          contents: [
            {
              role: "user",
              parts: [{ text: opts.userMessage }],
            },
          ],
          ttl: "300s",
        },
      });
      cachedContentName = cache.name ?? null;
      cacheCreationTokens = cache.usageMetadata?.totalTokenCount ?? 0;
    } catch {
      // Cache too small or rejected — fall through; samples will pay full prefix per call.
      cachedContentName = null;
    }

    const samples = await Promise.all(
      Array.from({ length: opts.samples }, () =>
        runOneSample(ai, opts, cachedContentName),
      ),
    );

    // Best-effort cleanup of the cache; don't fail the run if delete errors.
    if (cachedContentName) {
      try { await ai.caches.delete({ name: cachedContentName }); } catch { /* ignore */ }
    }

    return {
      samples,
      totalCostUsd: samples.reduce((a, s) => a + s.costUsd, 0),
      totalTurns: samples.reduce((a, s) => a + s.turns, 0),
      totalCacheCreationTokens: cacheCreationTokens,
      totalCacheReadTokens: samples.reduce((a, s) => a + s.cacheReadTokens, 0),
      provider: "google",
    };
  }
}

async function runOneSample(
  ai: GoogleGenAI,
  opts: RunnerOptions,
  cachedContentName: string | null,
): Promise<SampleResult> {
  const tools = buildToolList(opts.tools, opts.outputSchema);

  // When using a cached prefix, the cache holds system + initial user message.
  // The conversation starts AFTER the cache: subsequent turns are tool_result
  // exchanges.
  //
  // When NOT cached, we send the prefix inline on every sample's first call.
  const contents: Content[] = cachedContentName
    ? []
    : [{ role: "user", parts: [{ text: opts.userMessage }] }];

  let totalCost = 0;
  let totalTurns = 0;
  let totalCacheRead = 0;
  let errorReason: string | undefined;

  while (totalTurns < opts.maxTurnsPerSample) {
    let response: Awaited<ReturnType<typeof ai.models.generateContent>>;
    try {
      response = await ai.models.generateContent({
        model: opts.model,
        contents,
        config: {
          ...(cachedContentName
            ? { cachedContent: cachedContentName }
            : { systemInstruction: opts.systemPrompt }),
          tools,
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        },
      });
    } catch (err) {
      return {
        structuredOutput: null,
        costUsd: totalCost,
        turns: totalTurns,
        cacheCreationTokens: 0,
        cacheReadTokens: totalCacheRead,
        errorReason: `api_error: ${(err as Error).message}`,
      };
    }

    const { cost, cacheReadTokens } = costOf(response.usageMetadata, opts.model);
    totalCost += cost;
    totalCacheRead += cacheReadTokens;
    totalTurns++;

    if (totalCost >= opts.maxBudgetUsdPerSample) {
      errorReason = "max_budget_exceeded";
      break;
    }

    const candidate = response.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];

    // submit_findings — structured-output signal
    const submit = parts.find(
      (p) => p.functionCall && p.functionCall.name === "submit_findings",
    );
    if (submit && submit.functionCall) {
      return {
        structuredOutput: submit.functionCall.args ?? null,
        costUsd: totalCost,
        turns: totalTurns,
        cacheCreationTokens: 0,
        cacheReadTokens: totalCacheRead,
      };
    }

    // Tool calls — execute and append functionResponse parts
    const functionCalls = parts.filter((p) => p.functionCall && p.functionCall.name !== "submit_findings");

    if (functionCalls.length === 0) {
      // Model produced final text but didn't call submit_findings.
      // Try to recover JSON from any text part.
      const textPart = parts.find((p) => typeof p.text === "string");
      let parsed: unknown = null;
      if (textPart?.text) {
        try {
          const t = textPart.text.trim();
          const start = t.indexOf("{");
          const end = t.lastIndexOf("}");
          if (start !== -1 && end > start) parsed = JSON.parse(t.slice(start, end + 1));
        } catch { /* ignore */ }
      }
      return {
        structuredOutput: parsed,
        costUsd: totalCost,
        turns: totalTurns,
        cacheCreationTokens: 0,
        cacheReadTokens: totalCacheRead,
        ...(parsed === null ? { errorReason: "end_turn_without_submit" } : {}),
      };
    }

    // Append model's tool-call message
    if (candidate?.content) contents.push(candidate.content);

    // Execute every tool call and append functionResponse parts
    const responseParts: Part[] = [];
    for (const callPart of functionCalls) {
      const fn = callPart.functionCall;
      if (!fn?.name) continue;
      try {
        const result = await executeTool(
          fn.name,
          (fn.args ?? {}) as Record<string, unknown>,
          opts.repoRoot,
        );
        responseParts.push({
          functionResponse: {
            name: fn.name,
            response: { result },
          },
        });
      } catch (err) {
        responseParts.push({
          functionResponse: {
            name: fn.name,
            response: { error: (err as Error).message },
          },
        });
      }
    }
    contents.push({ role: "user", parts: responseParts });
  }

  return {
    structuredOutput: null,
    costUsd: totalCost,
    turns: totalTurns,
    cacheCreationTokens: 0,
    cacheReadTokens: totalCacheRead,
    errorReason: errorReason ?? "max_turns_reached",
  };
}

function buildToolList(enabled: string[], outputSchema: Record<string, unknown>): Tool[] {
  const declarations: FunctionDeclaration[] = [];
  if (enabled.includes("Read")) declarations.push(READ_DECL);
  if (enabled.includes("Grep")) declarations.push(GREP_DECL);
  if (enabled.includes("Glob")) declarations.push(GLOB_DECL);
  declarations.push({
    name: "submit_findings",
    description:
      "Submit your structured findings as the FINAL action. Call this exactly ONCE when you have completed the review. After calling submit_findings, do not make further function calls.",
    parameters: outputSchema as FunctionDeclaration["parameters"],
  });
  return [{ functionDeclarations: declarations }];
}

const READ_DECL: FunctionDeclaration = {
  name: "Read",
  description:
    "Read a file at a path relative to the repo root. Use to verify cross-references and inspect cited files.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: { type: Type.STRING, description: "Path relative to repoRoot" },
    },
    required: ["path"],
  },
};

const GREP_DECL: FunctionDeclaration = {
  name: "Grep",
  description:
    "Search for a regex pattern across files in the repo. Returns matching lines with file:line prefix.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pattern: { type: Type.STRING, description: "Regex pattern to search for" },
      path: { type: Type.STRING, description: "Optional subdir (relative to repoRoot) to limit the search" },
    },
    required: ["pattern"],
  },
};

const GLOB_DECL: FunctionDeclaration = {
  name: "Glob",
  description: "List file paths matching a glob pattern under the repo root.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      pattern: { type: Type.STRING, description: "Glob pattern, e.g. '*.yaml', 'Dockerfile'" },
    },
    required: ["pattern"],
  },
};

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
    return content.length > CAP
      ? content.slice(0, CAP) + `\n... [truncated; full size ${content.length} chars]`
      : content;
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
