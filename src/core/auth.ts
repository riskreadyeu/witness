/**
 * Auth-mode detection.
 *
 * Why this exists:
 *   - The SDK reports a `total_cost_usd` per query under both auth modes.
 *   - On API-key auth (ANTHROPIC_API_KEY) that number is unambiguously real
 *     money.
 *   - On a Pro/Max subscription (`claude login`) it was ASSUMED to be a
 *     theoretical figure the flat-rate plan absorbs. Witness's own
 *     measurements refute that assumption: a spec E2E billed ~$2.89 with
 *     `~/.claude/.credentials.json` present (see ISA.md Run 2), the bundled
 *     agent SDK bills at `service_tier: standard` regardless of the creds
 *     file, and the OAuth bearer used by claude-direct-runner authenticates
 *     but still meters at standard API rates. Treat every witness run as
 *     potentially real spend until subscription billing is confirmed end to
 *     end — do NOT rely on "subscription = free."
 *   - The `maxBudgetUsd` cap fires under both modes; this detection only
 *     picks a DEFAULT cap, generous for subscription (the real bottleneck
 *     there is Anthropic's rate limits, not dollars) and tight for API keys.
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
 * Subscription: generous default ($10) — a runaway-loop backstop, NOT a
 *   "you don't pay this" guarantee. Witness's measurements show subscription
 *   runs still meter real cost (see detectAuth comment + ISA.md). The reason
 *   the default is loose is that on subscription the binding limit is usually
 *   Anthropic's rate window, not the dollar figure — but the dollars are not
 *   known to be free.
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
