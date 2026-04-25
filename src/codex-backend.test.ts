import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { CodexCliBackend, type CodexExecRunner } from "./codex-backend.js";

const FINDING = {
  kind: "bug",
  severity: "high",
  file: "src/user.ts",
  startLine: 10,
  endLine: 10,
  title: "missing await on async call",
  why: "Line 10 starts async work but returns before it can complete.",
  confidence: "high",
};

describe("CodexCliBackend", () => {
  it("runs codex exec in read-only mode with the review schema", async () => {
    const calls: Array<{ args: string[]; cwd: string; input: string }> = [];
    const runner: CodexExecRunner = async ({ args, cwd, input }) => {
      calls.push({ args, cwd, input });

      const schemaPath = valueAfter(args, "--output-schema");
      const outputPath = valueAfter(args, "--output-last-message");
      const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as { type?: string };
      expect(schema.type).toBe("object");

      await writeFile(outputPath, JSON.stringify({ findings: [FINDING] }), "utf-8");
      return { stdout: "", stderr: "" };
    };

    const backend = new CodexCliBackend(runner);
    const result = await backend.runSample({
      prompt: "review this diff",
      repoRoot: "/repo",
      model: "gpt-5.2",
    });

    expect(result.findings).toEqual([FINDING]);
    expect(result.costUsd).toBe(0);
    expect(result.turns).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe("/repo");
    expect(calls[0]!.input).toContain("You are Witness, a read-only code reviewer");
    expect(calls[0]!.input).toContain("Codex CLI");
    expect(calls[0]!.input).toContain("review this diff");
    expect(calls[0]!.args).toContain("exec");
    expect(calls[0]!.args).toContain("--sandbox");
    expect(calls[0]!.args).toContain("read-only");
    expect(calls[0]!.args).toContain("--ask-for-approval");
    expect(calls[0]!.args).toContain("never");
    expect(calls[0]!.args).toContain("--cd");
    expect(calls[0]!.args).toContain("/repo");
    expect(calls[0]!.args).toContain("--output-schema");
    expect(calls[0]!.args).toContain("--output-last-message");
    expect(calls[0]!.args).toContain("-m");
    expect(calls[0]!.args).toContain("gpt-5.2");
    expect(calls[0]!.args.at(-1)).toBe("-");
    expect(calls[0]!.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("returns a parse failure when Codex writes invalid schema output", async () => {
    const runner: CodexExecRunner = async ({ args }) => {
      await writeFile(valueAfter(args, "--output-last-message"), JSON.stringify({
        findings: [{ ...FINDING, file: "../../secret" }],
      }), "utf-8");
      return { stdout: "", stderr: "" };
    };

    const backend = new CodexCliBackend(runner);
    const result = await backend.runSample({
      prompt: "review this diff",
      repoRoot: "/repo",
    });

    expect(result.findings).toBeNull();
    expect(result.errorReason).toMatch(/zod validation failed/i);
  });
});

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index === -1) throw new Error(`missing ${flag}`);
  const value = args[index + 1];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}
