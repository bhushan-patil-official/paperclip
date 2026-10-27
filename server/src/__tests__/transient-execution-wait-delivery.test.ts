import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { deliverTransientExecutionWaits } from "../services/execution-recovery-resolution.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * OCTPC-130 / OCTPC-117: an agent finishes and reassigns the issue. The next agent's
 * `issue_assigned` wake arrives while the previous run is still releasing its
 * environment lease, is recorded as a skipped `execution_reconciliation_required`
 * receipt, and was never retried. These tests pin which receipts are resumed and,
 * just as important, which deliberately skipped ones are NOT.
 */
describeEmbeddedPostgres("deliverTransientExecutionWaits", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-transient-wait-delivery-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(overrides: { issueStatus?: string; assignToOther?: boolean } = {}) {
    const companyId = randomUUID();
    const staffId = randomUUID();
    const otherId = randomUUID();
    const issueId = randomUUID();
    const prefix = `TW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Wait Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const base = { companyId, status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} };
    await db.insert(agents).values([
      { id: staffId, name: "Staff Engineer", role: "engineer", ...base },
      { id: otherId, name: "PM", role: "pm", ...base },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Day pass commission",
      status: overrides.issueStatus ?? "todo",
      priority: "medium",
      assigneeAgentId: overrides.assignToOther ? otherId : staffId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return { companyId, staffId, otherId, issueId };
  }

  async function seedReceipt(
    f: { companyId: string; staffId: string; issueId: string },
    opts: { ageMs?: number; recoveryActionId?: string | null; reason?: string; wakeReason?: string } = {},
  ) {
    const createdAt = new Date(Date.now() - (opts.ageMs ?? 60_000));
    const [row] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: f.companyId,
        agentId: f.staffId,
        source: "assignment",
        triggerDetail: "system",
        reason: opts.reason ?? "execution_reconciliation_required",
        status: "skipped",
        createdAt,
        finishedAt: createdAt,
        error: "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
        payload: {
          issueId: f.issueId,
          mutation: "update",
          executionWait: {
            reason: "execution_recovery",
            message: "Waiting for execution recovery. Your message is saved.",
            recoveryActionId: opts.recoveryActionId ?? null,
            requestedIdempotencyKey: null,
          },
          _paperclipWakeContext: { issueId: f.issueId, wakeReason: opts.wakeReason ?? "issue_assigned", wakeSource: "assignment" },
        },
      })
      .returning();
    return row!;
  }

  const makeWake = () => vi.fn(async () => ({ id: randomUUID() }) as never) as unknown as Parameters<typeof deliverTransientExecutionWaits>[1] & ReturnType<typeof vi.fn>;

  it("resumes a skipped hand-off wake once, after the blocker has cleared", async () => {
    const f = await seed();
    const receipt = await seedReceipt(f);
    const wake = makeWake();

    await deliverTransientExecutionWaits(db, wake);

    expect(wake).toHaveBeenCalledTimes(1);
    const [agentId, options] = (wake as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(agentId).toBe(f.staffId);
    expect(options).toMatchObject({
      reason: "issue_assigned",
      idempotencyKey: `transient-wait-resume:${receipt.id}`,
      payload: { issueId: f.issueId },
    });
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect((after!.payload as any).executionWait.resumedAt).toBeTruthy();
    expect((after!.payload as any).transientWaitResume).toBe("resumed");

    // A later sweep must not resume it again.
    await deliverTransientExecutionWaits(db, wake);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("does not resume while a recovery hold still blocks the issue", async () => {
    const f = await seed();
    const receipt = await seedReceipt(f);
    await db.insert(issueRecoveryActions).values({
      companyId: f.companyId,
      sourceIssueId: f.issueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      returnOwnerAgentId: f.staffId,
      cause: "uncertain_external_action",
      fingerprint: randomUUID(),
      nextAction: "A person must inspect this.",
      evidence: { runId: randomUUID() },
    });
    const wake = makeWake();

    await deliverTransientExecutionWaits(db, wake);

    expect(wake).not.toHaveBeenCalled();
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect((after!.payload as any).executionWait.resumedAt).toBeUndefined();
  });

  it("never resumes a wake that a recovery action deliberately holds", async () => {
    const f = await seed();
    await seedReceipt(f, { recoveryActionId: randomUUID() });
    const wake = makeWake();
    await deliverTransientExecutionWaits(db, wake);
    expect(wake).not.toHaveBeenCalled();
  });

  it("ignores other skip reasons and other kinds of wake", async () => {
    const f = await seed();
    await seedReceipt(f, { reason: "issue_dependencies_blocked" });
    await seedReceipt(f, { wakeReason: "issue_commented" });
    const wake = makeWake();
    await deliverTransientExecutionWaits(db, wake);
    expect(wake).not.toHaveBeenCalled();
  });

  it("ignores receipts older than the resume window", async () => {
    const f = await seed();
    await seedReceipt(f, { ageMs: 31 * 60 * 1000 });
    const wake = makeWake();
    await deliverTransientExecutionWaits(db, wake);
    expect(wake).not.toHaveBeenCalled();
  });

  it("drops the receipt when the issue is no longer waiting on that agent", async () => {
    for (const overrides of [{ issueStatus: "blocked" }, { issueStatus: "done" }, { assignToOther: true }]) {
      const f = await seed(overrides);
      const receipt = await seedReceipt(f);
      const wake = makeWake();
      await deliverTransientExecutionWaits(db, wake);
      expect(wake).not.toHaveBeenCalled();
      const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
      expect((after!.payload as any).transientWaitResume).toBe("invalidated");
    }
  });

  it("does not resume when a run already happened for that agent and issue since the skip", async () => {
    const f = await seed();
    const receipt = await seedReceipt(f, { ageMs: 120_000 });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: f.companyId,
      agentId: f.staffId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: f.issueId },
    });
    const wake = makeWake();
    await deliverTransientExecutionWaits(db, wake);
    expect(wake).not.toHaveBeenCalled();
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect((after!.payload as any).transientWaitResume).toBe("superseded");
  });

  it("leaves the receipt retryable when the wake itself fails", async () => {
    const f = await seed();
    const receipt = await seedReceipt(f);
    const wake = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as Parameters<typeof deliverTransientExecutionWaits>[1];
    await deliverTransientExecutionWaits(db, wake);
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect((after!.payload as any).executionWait.resumedAt).toBeUndefined();
    const ok = makeWake();
    await deliverTransientExecutionWaits(db, ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
