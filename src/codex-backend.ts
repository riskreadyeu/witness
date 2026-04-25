import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewerBackend, ReviewerBackendOptions, BackendSampleResult } from "./backend.js";
import { reviewResponseJsonSchema } from "./json-schema.js";
import { CODEX_SYSTEM_PROMPT } from "./prompt.js";
import { ReviewResponseSchema } from "./schema.js";

export interface CodexExecRun {
  args: string[];
  cwd: string;
  input: string;
}

export interface CodexExecResult {
  stdout: string;
  stderr: string;
}

export type CodexExecRunner = (run: CodexExecRun) => Promise<CodexExecResult>;

export class CodexCliBackend implements ReviewerBackend {
  constructor(private readonly runner: CodexExecRunner = defaultCodexExecRunner) {}

  async runSample(options: ReviewerBackendOptions): Promise<BackendSampleResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "witness-codex-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "last-message.json");

    try {
      await writeFile(schemaPath, JSON.stringify(reviewResponseJsonSchema, null, 2), "utf-8");

      const args = [
        "exec",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "--cd",
        options.repoRoot,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "--color",
        "never",
        "--ephemeral",
      ];

      if (options.model) {
        args.push("-m", options.model);
      }

      args.push("-");

      const result = await this.runner({
        args,
        cwd: options.repoRoot,
        input: `${CODEX_SYSTEM_PROMPT}\n\n${options.prompt}`,
      });

      let rawText = "";
      try {
        rawText = await readFile(outputPath, "utf-8");
      } catch {
        rawText = result.stdout;
      }

      const structuredOutput = tryParseJson(rawText);
      if (structuredOutput === undefined) {
        return {
          findings: null,
          costUsd: 0,
          turns: 0,
          errorReason: "codex produced no parseable JSON output",
          rawText: rawText || result.stderr,
        };
      }

      const parsed = ReviewResponseSchema.safeParse(structuredOutput);
      if (!parsed.success) {
        return {
          findings: null,
          costUsd: 0,
          turns: 0,
          errorReason: `zod validation failed: ${parsed.error.message}`,
          rawText: JSON.stringify(structuredOutput).slice(0, 2000),
        };
      }

      return { findings: parsed.data.findings, costUsd: 0, turns: 0 };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Wall-clock cap per codex sample. Codex doesn't expose anything analogous
 * to the SDK's per-query maxBudgetUsd / maxTurns, so a stuck child can hang
 * the whole `Promise.all` of N samples forever. This kills it instead.
 */
const CODEX_SAMPLE_TIMEOUT_MS = 5 * 60 * 1000;

async function defaultCodexExecRunner(run: CodexExecRun): Promise<CodexExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", run.args, {
      cwd: run.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so codex can clean up; SIGKILL as a backstop in case
      // it ignores the polite signal.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, CODEX_SAMPLE_TIMEOUT_MS);
    timer.unref();

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `codex sample timed out after ${CODEX_SAMPLE_TIMEOUT_MS / 1000}s and was killed`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`codex exited with code ${code}: ${stderr || stdout}`));
      }
    });

    child.stdin.end(run.input);
  });
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}
