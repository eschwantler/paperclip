import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import {
  REPLY_OUTCOME_ACTIVITY_ACTION,
  applyAdapterReplyOutcome,
  createReplyOutcomeDeps,
} from "../services/adapter-reply-outcome.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reply outcome tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DIGEST = "b".repeat(64);

describeEmbeddedPostgres("record a gateway reply as the task outcome (real database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reply-outcome-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(status = "in_progress", assignToAgent = true) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reply outcome", issuePrefix: "RPO" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Fred", role: "general", adapterType: "hermes_gateway",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Status check", status,
      assigneeAgentId: assignToAgent ? agentId : null, issueNumber: 1, identifier: "RPO-1",
    });
    const runIds = { a: randomUUID(), b: randomUUID() };
    await db.insert(heartbeatRuns).values(
      Object.values(runIds).map((id) => ({ id, companyId, agentId, status: "succeeded", invocationSource: "assignment" })),
    );
    return { companyId, agentId, issueId, runIds };
  }

  const run = (ids: { agentId: string; issueId: string }, runId: string) => ({
    enabled: true,
    adapterRecordsOutcome: true,
    runSucceeded: true,
    outcome: { kind: "reply_delivered" as const, replyDigest: DIGEST },
    issueId: ids.issueId,
    run: { id: runId },
    agent: { id: ids.agentId, runtimeConfig: {} },
  });

  const apply = (ids: { agentId: string; issueId: string }, runId: string) => {
    const svc = issueService(db);
    return applyAdapterReplyOutcome(createReplyOutcomeDeps(db, (id, data) => svc.update(id, data)), run(ids, runId));
  };

  const statusOf = async (issueId: string) =>
    (await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]?.status;

  const entries = async (issueId: string) =>
    db.select().from(activityLog).where(eq(activityLog.entityId, issueId));

  it("moves an in-progress task to done and writes one activity entry with the digest", async () => {
    const ids = await seed();
    const result = await apply(ids, ids.runIds.a);
    expect(result).toEqual({ recorded: true, status: "done" });
    expect(await statusOf(ids.issueId)).toBe("done");
    const rows = (await entries(ids.issueId)).filter((row) => row.action === REPLY_OUTCOME_ACTIVITY_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "issue", agentId: ids.agentId, runId: ids.runIds.a });
    expect(rows[0]!.details).toMatchObject({ status: "done", replyDigest: DIGEST });
  });

  it("is idempotent for the same run and digest, matching the activity row by its JSON digest", async () => {
    const ids = await seed();
    await apply(ids, ids.runIds.a);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, ids.issueId));
    const second = await apply(ids, ids.runIds.a);
    expect(second).toEqual({ recorded: false, reason: "already_recorded" });
    expect(await statusOf(ids.issueId)).toBe("in_progress");
    expect((await entries(ids.issueId)).filter((row) => row.action === REPLY_OUTCOME_ACTIVITY_ACTION)).toHaveLength(1);
  });

  it("records again for a different run, since that is a new reply", async () => {
    const ids = await seed();
    await apply(ids, ids.runIds.a);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, ids.issueId));
    expect(await apply(ids, ids.runIds.b)).toEqual({ recorded: true, status: "done" });
  });

  it.each(["todo", "blocked", "in_review", "done", "cancelled"])("leaves a task that is already %s alone", async (status) => {
    const ids = await seed(status);
    expect(await apply(ids, ids.runIds.a)).toEqual({ recorded: false, reason: "issue_not_in_progress" });
    expect(await statusOf(ids.issueId)).toBe(status);
    expect(await entries(ids.issueId)).toHaveLength(0);
  });

  it("leaves a task alone that is not assigned to the agent", async () => {
    const ids = await seed("in_progress", false);
    expect(await apply(ids, ids.runIds.a)).toEqual({ recorded: false, reason: "issue_not_assigned_to_agent" });
    expect(await statusOf(ids.issueId)).toBe("in_progress");
  });

  it("does not overwrite a status a person sets between the read and the write", async () => {
    const ids = await seed();
    const svc = issueService(db);
    const deps = createReplyOutcomeDeps(db, (id, data) => svc.update(id, data));
    const racing = {
      ...deps,
      async moveIssue(input: Parameters<typeof deps.moveIssue>[0]) {
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, ids.issueId));
        return deps.moveIssue(input);
      },
    };
    const result = await applyAdapterReplyOutcome(racing, run(ids, ids.runIds.a));
    expect(result).toEqual({ recorded: false, reason: "issue_changed_concurrently" });
    expect(await statusOf(ids.issueId)).toBe("blocked");
    expect(await entries(ids.issueId)).toHaveLength(0);
  });
});
