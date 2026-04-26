/**
 * Auth-mode detection.
 *
 * Why this exists:
 *   - On a Pro/Max subscription (after `claude login`), the Anthropic SDK
 *     still reports a `total_cost_usd` per query — but that's a *theoretical*
 *     dollar amount (tokens × rate card), not real money. The user pays $0
 *     because the subscription is flat-rate.
 *   - On API-key auth (ANTHROPIC_API_KEY), the same number is real money.
 *   - The SDK's `maxBudgetUsd` cap fires regardless. So a default budget
 *     that protects API-key users from runaway spend (e.g. $1/sample) will
 *     unnecessarily abort subscription users on long diffs.
 *
 * Detection strategy:
 *   - `~/.claude/.credentials.json` exists → subscription is configured.
 *     The SDK prefers OAuth credentials over the env var when both are
 *     present, so file presence is the truth even if ANTHROPIC_API_KEY is
 *     also set.
 *   - Else if ANTHROPIC_API_KEY is set → API-key auth.
 *   - Else → unknown (SDK will fail with an auth error; we use the
 *     conservative default).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthOverride = "subscription" | "api-key" | "auto";
export type AuthMode = "subscription" | "api-key" | "unknown";

const SUBSCRIPTION_CREDENTIALS = join(homedir(), ".claude", ".credentials.json");

export function detectAuth(override?: AuthOverride): AuthMode {
  if (override === "subscription") return "subscription";
  if (override === "api-key") return "api-key";
  if (existsSync(SUBSCRIPTION_CREDENTIALS)) return "subscription";
  if (process.env.ANTHROPIC_API_KEY) return "api-key";
  return "unknown";
}

/**
 * Default per-sample budget cap by auth mode.
 *
 * Subscription: generous runaway-protection only ($10 of *theoretical*
 *   dollars; you don't pay this).
 *
 * API-key / unknown: tight default ($1) because the dollars are real.
 *
 * Override anytime with `--budget`. Override the auth detection with `--auth`.
 */
export function defaultBudgetForAuth(auth: AuthMode): number {
  return auth === "subscription" ? 10.0 : 1.0;
}

export function describeAuth(auth: AuthMode): string {
  switch (auth) {
    case "subscription": return "subscription";
    case "api-key":      return "API key";
    case "unknown":      return "unknown auth";
  }
}
