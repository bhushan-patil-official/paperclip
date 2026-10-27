import { describe, expect, it } from "vitest";
import { didAutomaticRecoveryFail } from "./service.js";

function run(status: string, errorCode: string | null, retryReason: string | null) {
  return {
    id: "run-1",
    agentId: "agent-1",
    status,
    error: null,
    errorCode,
    contextSnapshot: retryReason ? { retryReason } : {},
    livenessState: null,
    startedAt: null,
    createdAt: new Date(),
  } as unknown as Parameters<typeof didAutomaticRecoveryFail>[0];
}

describe("didAutomaticRecoveryFail", () => {
  it("does not treat a recovery run cancelled by a hand-off (issue_reassigned) as a failed recovery", () => {
    // WOR-117: QA's continuation retry finished its work, reassigned the issue
    // to the Staff Engineer, and its own run was cancelled with issue_reassigned.
    expect(didAutomaticRecoveryFail(run("cancelled", "issue_reassigned", "issue_continuation_needed"), "issue_continuation_needed")).toBe(false);
    expect(didAutomaticRecoveryFail(run("cancelled", "issue_reassigned", "assignment_recovery"), "assignment_recovery")).toBe(false);
  });

  it("still treats a genuinely failed or otherwise cancelled recovery run as failed", () => {
    expect(didAutomaticRecoveryFail(run("failed", "adapter_failed", "issue_continuation_needed"), "issue_continuation_needed")).toBe(true);
    expect(didAutomaticRecoveryFail(run("timed_out", null, "assignment_recovery"), "assignment_recovery")).toBe(true);
    expect(didAutomaticRecoveryFail(run("cancelled", "operator_cancelled", "issue_continuation_needed"), "issue_continuation_needed")).toBe(true);
  });

  it("ignores runs that are not the expected recovery kind, and missing runs", () => {
    expect(didAutomaticRecoveryFail(run("failed", "adapter_failed", "assignment_recovery"), "issue_continuation_needed")).toBe(false);
    expect(didAutomaticRecoveryFail(run("failed", "adapter_failed", null), "issue_continuation_needed")).toBe(false);
    expect(didAutomaticRecoveryFail(null as never, "issue_continuation_needed")).toBe(false);
  });
});
