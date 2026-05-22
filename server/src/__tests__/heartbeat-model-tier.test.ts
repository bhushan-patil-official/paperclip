import { describe, expect, it } from "vitest";
import type { AdapterModelProfileDefinition } from "../adapters/index.js";
import {
  resolveModelProfileApplication,
  resolveModelTierFromIssuePriority,
} from "../services/heartbeat.ts";

const tierProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "simple",
    label: "Simple",
    adapterConfig: { model: "simple-model" },
    source: "adapter_default",
  },
  {
    key: "expert",
    label: "Expert",
    adapterConfig: { model: "expert-model" },
    source: "adapter_default",
  },
];

describe("resolveModelTierFromIssuePriority", () => {
  it("returns null when no tier rules are configured", () => {
    expect(resolveModelTierFromIssuePriority("high", {})).toBeNull();
  });

  it("maps issue priority to configured tier keys", () => {
    expect(
      resolveModelTierFromIssuePriority("critical", {
        modelTierRules: {
          priority: { critical: "expert", low: "simple" },
          default: "simple",
        },
      }),
    ).toBe("expert");
  });

  it("falls back to default tier when priority is missing", () => {
    expect(
      resolveModelTierFromIssuePriority("medium", {
        modelTierRules: {
          priority: { low: "simple" },
          default: "simple",
        },
      }),
    ).toBe("simple");
  });
});

describe("resolveModelProfileApplication with issue priority", () => {
  it("applies tier from issue priority when no explicit profile override exists", () => {
    const application = resolveModelProfileApplication({
      adapterModelProfiles: tierProfiles,
      agentRuntimeConfig: {
        modelTierRules: {
          priority: { critical: "expert" },
        },
      },
      issueModelProfile: null,
      issuePriority: "critical",
      contextSnapshot: {},
    });

    expect(application).toMatchObject({
      requested: "expert",
      requestedBy: "issue_priority",
      applied: "expert",
      adapterConfig: { model: "expert-model" },
    });
  });
});
