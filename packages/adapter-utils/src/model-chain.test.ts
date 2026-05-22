import { describe, expect, it, vi } from "vitest";
import {
  GENERIC_RATE_LIMIT_RE,
  isGenericRateLimitedText,
  mergeChainEntryIntoConfig,
  parseModelChainFromConfig,
  runWithModelFallbackChain,
} from "./model-chain.js";

describe("parseModelChainFromConfig", () => {
  it("returns primary model first then fallbacks", () => {
    const chain = parseModelChainFromConfig({
      model: "primary/model",
      variant: "low",
      modelChain: [
        { model: "fallback/a", variant: "high" },
        { model: "fallback/b", env: { API_KEY: "x" } },
      ],
    });
    expect(chain).toEqual([
      { model: "primary/model", variant: "low" },
      { model: "fallback/a", variant: "high" },
      { model: "fallback/b", env: { API_KEY: "x" } },
    ]);
  });

  it("returns only fallbacks when primary model is absent", () => {
    expect(
      parseModelChainFromConfig({
        modelChain: [{ model: "only/fallback" }],
      }),
    ).toEqual([{ model: "only/fallback" }]);
  });
});

describe("runWithModelFallbackChain", () => {
  it("stops on first non-rate-limited attempt", async () => {
    const onSwitch = vi.fn();
    const result = await runWithModelFallbackChain({
      chain: [{ model: "a" }, { model: "b" }],
      sessionId: "sess-1",
      execute: async (_entry, sessionId) => ({ sessionId, rateLimited: false }),
      isRateLimited: (attempt) => attempt.rateLimited,
      onSwitch,
    });
    expect(result.exhausted).toBe(false);
    expect(result.chainIndex).toBe(0);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("switches models and clears session after first entry", async () => {
    const sessions: Array<string | null> = [];
    const onSwitch = vi.fn();
    const result = await runWithModelFallbackChain({
      chain: [{ model: "a" }, { model: "b" }],
      sessionId: "sess-1",
      execute: async (_entry, sessionId) => {
        sessions.push(sessionId);
        return { rateLimited: _entry.model === "a" };
      },
      isRateLimited: (attempt) => attempt.rateLimited,
      onSwitch,
    });
    expect(sessions).toEqual(["sess-1", null]);
    expect(result.exhausted).toBe(false);
    expect(result.chainIndex).toBe(1);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it("marks exhausted when every entry is rate-limited", async () => {
    const result = await runWithModelFallbackChain({
      chain: [{ model: "a" }, { model: "b" }],
      sessionId: null,
      execute: async () => ({ rateLimited: true }),
      isRateLimited: (attempt) => attempt.rateLimited,
      onSwitch: async () => {},
    });
    expect(result.exhausted).toBe(true);
    expect(result.chainIndex).toBe(2);
  });
});

describe("mergeChainEntryIntoConfig", () => {
  it("merges model, variant, and per-entry env", () => {
    expect(
      mergeChainEntryIntoConfig(
        { model: "old", env: { BASE: "1" } },
        { model: "new", variant: "high", env: { API_KEY: "secret" } },
      ),
    ).toEqual({
      model: "new",
      variant: "high",
      env: { BASE: "1", API_KEY: "secret" },
    });
  });
});

describe("GENERIC_RATE_LIMIT_RE", () => {
  it("matches common provider rate-limit phrases", () => {
    expect(isGenericRateLimitedText("Error: rate limit exceeded")).toBe(true);
    expect(isGenericRateLimitedText("HTTP 429 Too Many Requests")).toBe(true);
    expect(isGenericRateLimitedText("RESOURCE_EXHAUSTED quota")).toBe(true);
    expect(GENERIC_RATE_LIMIT_RE.test("FreeUsageLimitError")).toBe(true);
    expect(isGenericRateLimitedText("connection reset")).toBe(false);
  });
});
