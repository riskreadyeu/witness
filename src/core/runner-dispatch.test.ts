/**
 * Provider-routing tests for the dispatcher.
 *
 * pickProvider is the seam that decides which runner serves a model. It was
 * untested; a wrong default here silently sends every stage to the wrong
 * backend. These pin the prefix rules and the default.
 */

import { describe, it, expect } from "vitest";
import { pickProvider } from "./runner-dispatch.js";

describe("pickProvider", () => {
  it("routes claude-* models to anthropic", () => {
    expect(pickProvider("claude-opus-4-7")).toBe("anthropic");
    expect(pickProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
  });

  it("routes gemini-* models to google", () => {
    expect(pickProvider("gemini-2.5-pro")).toBe("google");
    expect(pickProvider("gemini-2.5-flash")).toBe("google");
  });

  it("defaults unknown model strings to anthropic", () => {
    expect(pickProvider("some-future-model")).toBe("anthropic");
    expect(pickProvider("")).toBe("anthropic");
  });

  it("honors an explicit provider override regardless of model prefix", () => {
    expect(pickProvider("gemini-2.5-pro", "anthropic")).toBe("anthropic");
    expect(pickProvider("claude-opus-4-7", "google")).toBe("google");
  });
});
