/**
 * Private-fixture extractor for closed-source repos (e.g., RiskReadyEU).
 *
 * READ-ONLY by design:
 *   - We invoke `git show` and `git diff` only. We never check out,
 *     fetch, pull, push, commit, rebase, clean, or modify the source
 *     repo's working tree.
 *   - We emit a fixture into `evals/fixtures-private/<name>/` which is
 *     gitignored in this repo.
 *   - No network calls.
 *   - No shell strings — we use execFileSync with an argv list, and we
 *     validate every commit SHA / path fragment we accept.
 *
 * Usage:
 *   # single commit
 *   tsx evals/extract-riskreadyeu.ts \
 *     --repo /home/daniel/projects/RISKREADYEU \
 *     --commit be968af \
 *     --name 001-routing-typo-breaks-nav \
 *     --kind bug
 *
 *   # batch from a config file
 *   tsx evals/extract-riskreadyeu.ts \
 *     --repo /home/daniel/projects/RISKREADYEU \
 *     --batch ./evals/riskreadyeu-batch.json
 *
 * After extraction, open each fixture's `expected.json` and fill in:
 *   - description (what was the bug)
 *   - expected[] (what should Oracle flag)
 *
 * The extractor seeds a skeleton but does NOT guess the findings.
 * Hand-curation is the whole point of a fixture.
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PRIVATE = resolve(__dirname, "fixtures-private");

const SAFE_SHA = /^[a-f0-9]{6,40}$/i;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;

interface BatchEntry {
  commit: string;
  name: string;
  kind?: string;
  description?: string;
}

interface ExtractArgs {
  repo: string;
  commit?: string;
  name?: string;
  kind?: string;
  batch?: string;
}

function parseArgs(argv: string[]): ExtractArgs {
  const args: Partial<ExtractArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    switch (a) {
      case "--repo":   args.repo   = argv[++i]; break;
      case "--commit": args.commit = argv[++i]; break;
      case "--name":   args.name   = argv[++i]; break;
      case "--kind":   args.kind   = argv[++i]; break;
      case "--batch":  args.batch  = argv[++i]; break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }
  if (!args.repo) {
    console.error("error: --repo is required");
    printHelp();
    process.exit(2);
  }
  return args as ExtractArgs;
}

function printHelp(): void {
  console.log(`extract-riskreadyeu — read-only private fixture extractor

usage:
  tsx evals/extract-riskreadyeu.ts --repo <path> (--commit <sha> --name <name> [--kind <kind>] | --batch <file>)

flags:
  --repo <path>     path to the source repo (read-only; never modified)
  --commit <sha>    git SHA (at least 6 hex chars) of the commit to extract
  --name <name>     fixture directory name (lowercase, [a-z0-9._-])
  --kind <kind>     suggested kind: bug | security | performance | refactor |
                    architectural | convention | question  (default: bug)
  --batch <file>    JSON file with an array of { commit, name, kind?, description? }

output:
  evals/fixtures-private/<name>/
    diff.patch     (git show --format= <sha>)
    after/         (git show <sha>:<path> for each touched file)
    expected.json  (skeleton — hand-annotate findings after)
    COMMIT.md      (commit message + author + date, for context)
`);
}

function git(repo: string, argv: string[]): string {
  return execFileSync("git", ["-C", repo, ...argv], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function gitBuffer(repo: string, argv: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...argv], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

function assertSafeRepo(repo: string): void {
  try {
    const top = git(repo, ["rev-parse", "--show-toplevel"]).trim();
    if (!top) throw new Error("not a git repo");
  } catch (e) {
    throw new Error(`--repo is not a valid git repository: ${repo} (${(e as Error).message})`);
  }
}

async function extractOne(
  repo: string,
  entry: { commit: string; name: string; kind?: string; description?: string },
): Promise<void> {
  if (!SAFE_SHA.test(entry.commit)) {
    throw new Error(`unsafe commit SHA: ${entry.commit}`);
  }
  if (!SAFE_NAME.test(entry.name)) {
    throw new Error(`unsafe fixture name: ${entry.name}`);
  }

  const fullSha = git(repo, ["rev-parse", "--verify", `${entry.commit}^{commit}`]).trim();

  const diff = git(repo, ["show", "--format=", fullSha]);
  const meta = git(repo, ["show", "--no-patch", "--format=%H%n%an%n%ae%n%ad%n%s%n%b", fullSha]);
  const changedFilesRaw = git(repo, [
    "diff-tree", "--no-commit-id", "--name-only", "-r", fullSha,
  ]);
  const changedFiles = changedFilesRaw.split("\n").map((l) => l.trim()).filter(Boolean);

  const destDir = join(FIXTURES_PRIVATE, entry.name);
  await mkdir(join(destDir, "after"), { recursive: true });
  await writeFile(join(destDir, "diff.patch"), diff, "utf-8");

  for (const relPath of changedFiles) {
    if (relPath.includes("..") || relPath.startsWith("/")) {
      console.warn(`  skipping suspicious path: ${relPath}`);
      continue;
    }
    try {
      const content = gitBuffer(repo, ["show", `${fullSha}:${relPath}`]);
      const dest = join(destDir, "after", relPath);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content);
    } catch {
      // file was deleted in this commit — no post-change content to extract
    }
  }

  const [sha, author, email, date, subject, ...bodyParts] = meta.split("\n");
  const body = bodyParts.join("\n").trim();
  const commitMd =
    `# ${subject}\n\n` +
    `- sha:    ${sha}\n` +
    `- author: ${author} <${email}>\n` +
    `- date:   ${date}\n\n` +
    (body ? `${body}\n` : "");
  await writeFile(join(destDir, "COMMIT.md"), commitMd, "utf-8");

  const skeleton = {
    name: entry.name,
    description: entry.description ?? `(manual: describe what the bug was, in one paragraph)`,
    _source: {
      repo: "(private — do not publish this fixture)",
      commit: sha,
      subject,
    },
    expected: [
      {
        key: `${entry.name}-primary`,
        kind: entry.kind ?? "bug",
        acceptableKinds: [entry.kind ?? "bug"],
        file: changedFiles[0] ?? "(fill in)",
        startLine: 1,
        endLine: 1,
        minSeverity: "medium",
        requiredPhrases: [],
        lineTolerance: 3,
        _hint: "(manual: fill in real file, line range, and 1-3 phrases that must appear in why)",
      },
    ],
    allowExtras: true,
  };
  await writeFile(
    join(destDir, "expected.json"),
    JSON.stringify(skeleton, null, 2),
    "utf-8",
  );

  console.log(`  wrote  ${destDir}`);
  console.log(`    diff.patch       (${diff.length} bytes)`);
  console.log(`    after/           (${changedFiles.length} files)`);
  console.log(`    COMMIT.md`);
  console.log(`    expected.json    (skeleton — hand-annotate before running)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = resolve(args.repo);
  assertSafeRepo(repo);

  const entries: BatchEntry[] = [];
  if (args.batch) {
    const loaded = JSON.parse(await readFile(resolve(args.batch), "utf-8")) as BatchEntry[];
    if (!Array.isArray(loaded)) throw new Error("--batch file must contain a JSON array");
    entries.push(...loaded);
  } else {
    if (!args.commit || !args.name) {
      console.error("error: --commit and --name are required without --batch");
      process.exit(2);
    }
    entries.push({ commit: args.commit, name: args.name, ...(args.kind ? { kind: args.kind } : {}) });
  }

  console.log(`extracting ${entries.length} fixture(s) from ${repo} into ${FIXTURES_PRIVATE}`);
  for (const entry of entries) {
    try {
      await extractOne(repo, entry);
    } catch (e) {
      console.error(`  FAILED ${entry.name}: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
