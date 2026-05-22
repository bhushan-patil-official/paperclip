import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema } from "./agent.js";

describe("agentRuntimeConfigSchema", () => {
  it("accepts all tier profile keys and modelTierRules", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      modelProfiles: {
        cheap: { adapterConfig: { model: "cheap-model" } },
        simple: { adapterConfig: { model: "simple-model" } },
        standard: { adapterConfig: { model: "standard-model" } },
        advanced: { adapterConfig: { model: "advanced-model" } },
        expert: { adapterConfig: { model: "expert-model" } },
      },
      modelTierRules: {
        priority: {
          low: "simple",
          medium: "standard",
          high: "advanced",
          critical: "expert",
        },
        default: "standard",
      },
    });

    expect(parsed.modelProfiles?.expert?.adapterConfig).toEqual({ model: "expert-model" });
    expect(parsed.modelTierRules?.default).toBe("standard");
  });

  it("rejects unknown model profile keys", () => {
    expect(() =>
      agentRuntimeConfigSchema.parse({
        modelProfiles: {
          unknown: { adapterConfig: { model: "x" } },
        },
      }),
    ).toThrow();
  });
});
