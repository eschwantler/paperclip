import { describe, expect, it } from "vitest";
import {
  applyAdapterReplyOutcome,
  resolveReplyOutcomeStatus,
  type ReplyOutcomeDeps,
  type ReplyOutcomeInput,
  type ReplyOutcomeIssue,
} from "../services/adapter-reply-outcome.ts";
import { decideLegacyContinuation } from "../services/recovery/legacy-continuation.ts";
import { classifyIssueReviewPaths } from "../services/recovery/issue-graph-liveness.ts";

const AGENT_ID = "agent-1";
const COMPANY_ID = "company-1";
const DIGEST = "a".repeat(64);

/** In-memory stand-in for the issue row and activity log, enough to check the rules and idempotency. */
function makeWorld(issue: Partial<ReplyOutcomeIssue> = {}) {
  const state = {
    issue: { id: "issue-1", companyId: COMPANY_ID, status: "in_progress", assigneeAgentId: AGENT_ID, ...issue } as ReplyOutcomeIssue,
    moves: [] as Array<{ status: string; runId: string }>,
    activity: [] as Array<{ runId: string; replyDigest: string; status: string }>,
    getIssueCalls: 0,
    /** Simulates a person changing the status between the read and the write. */
    changeBeforeMove: null as null | (() => void),
  };
  const deps: ReplyOutcomeDeps = {
    async getIssue() {
      state.getIssueCalls += 1;
      return { ...state.issue };
    },
    async alreadyRecorded({ runId, replyDigest }) {
      return state.activity.some((entry) => entry.runId === runId && entry.replyDigest === replyDigest);
    },
    async moveIssue({ status, runId }) {
      state.changeBeforeMove?.();
      if (state.issue.status !== "in_progress" || state.issue.assigneeAgentId !== AGENT_ID) return false;
      state.issue.status = status;
      state.moves.push({ status, runId });
      return true;
    },
    async logRecorded({ runId, replyDigest, status }) {
      state.activity.push({ runId, replyDigest, status });
    },
  };
  return { state, deps };
}

const baseInput = (overrides: Partial<ReplyOutcomeInput> = {}): ReplyOutcomeInput => ({
  enabled: true,
  adapterRecordsOutcome: true,
  runSucceeded: true,
  outcome: { kind: "reply_delivered", replyDigest: DIGEST },
  issueId: "issue-1",
  run: { id: "run-1" },
  agent: { id: AGENT_ID, runtimeConfig: {} },
  ...overrides,
});

describe("record a gateway reply as the task outcome", () => {
  it("moves an in-progress task to done by default, with one activity entry", async () => {
    const { state, deps } = makeWorld();
    const result = await applyAdapterReplyOutcome(deps, baseInput());
    expect(result).toEqual({ recorded: true, status: "done" });
    expect(state.issue.status).toBe("done");
    expect(state.moves).toEqual([{ status: "done", runId: "run-1" }]);
    expect(state.activity).toEqual([{ runId: "run-1", replyDigest: DIGEST, status: "done" }]);
  });

  it("uses the agent's replyOutcomeStatus when it is in_review", async () => {
    const { state, deps } = makeWorld();
    const result = await applyAdapterReplyOutcome(deps, baseInput({ agent: { id: AGENT_ID, runtimeConfig: { replyOutcomeStatus: "in_review" } } }));
    expect(result).toEqual({ recorded: true, status: "in_review" });
    expect(state.issue.status).toBe("in_review");
  });

  it("falls back to done for an unknown replyOutcomeStatus", () => {
    expect(resolveReplyOutcomeStatus(undefined)).toBe("done");
    expect(resolveReplyOutcomeStatus(null)).toBe("done");
    expect(resolveReplyOutcomeStatus({ replyOutcomeStatus: "cancelled" })).toBe("done");
    expect(resolveReplyOutcomeStatus({ replyOutcomeStatus: "done" })).toBe("done");
    expect(resolveReplyOutcomeStatus({ replyOutcomeStatus: "in_review" })).toBe("in_review");
  });

  it("is idempotent: the same run and reply digest is recorded once", async () => {
    const { state, deps } = makeWorld();
    await applyAdapterReplyOutcome(deps, baseInput());
    // A redelivered reply or a retried completion handler: the issue is put back in progress by nothing,
    // so check the guard that matters here, the activity key.
    state.issue.status = "in_progress";
    const second = await applyAdapterReplyOutcome(deps, baseInput());
    expect(second).toEqual({ recorded: false, reason: "already_recorded" });
    expect(state.moves).toHaveLength(1);
    expect(state.activity).toHaveLength(1);
  });

  it("is a no-op when the setting is off, without reading the issue", async () => {
    const { state, deps } = makeWorld();
    const result = await applyAdapterReplyOutcome(deps, baseInput({ enabled: false }));
    expect(result).toEqual({ recorded: false, reason: "setting_off" });
    expect(state.getIssueCalls).toBe(0);
    expect(state.issue.status).toBe("in_progress");
    expect(state.activity).toEqual([]);
  });

  it("does nothing for an adapter that does not declare recordsOutcomeForAgent", async () => {
    const { state, deps } = makeWorld();
    const result = await applyAdapterReplyOutcome(deps, baseInput({ adapterRecordsOutcome: false }));
    expect(result.recorded).toBe(false);
    expect(state.getIssueCalls).toBe(0);
  });

  it.each([
    ["the run failed", { runSucceeded: false }],
    ["the adapter returned no outcome (HTTP error, timeout, malformed response)", { outcome: undefined }],
    ["the outcome kind is unknown", { outcome: { kind: "something_else" } as never }],
    ["there is no issue", { issueId: null }],
  ])("records nothing when %s, so today's retry and recovery path is unchanged", async (_label, overrides) => {
    const { state, deps } = makeWorld();
    const result = await applyAdapterReplyOutcome(deps, baseInput(overrides as Partial<ReplyOutcomeInput>));
    expect(result.recorded).toBe(false);
    expect(state.issue.status).toBe("in_progress");
    expect(state.moves).toEqual([]);
    expect(state.activity).toEqual([]);
  });

  it.each(["todo", "blocked", "in_review", "done", "cancelled"])(
    "lets a person's status win: a task already %s is left alone",
    async (status) => {
      const { state, deps } = makeWorld({ status });
      const result = await applyAdapterReplyOutcome(deps, baseInput());
      expect(result).toEqual({ recorded: false, reason: "issue_not_in_progress" });
      expect(state.issue.status).toBe(status);
      expect(state.activity).toEqual([]);
    },
  );

  it("leaves a task alone that was reassigned to someone else", async () => {
    const { state, deps } = makeWorld({ assigneeAgentId: "agent-2" });
    const result = await applyAdapterReplyOutcome(deps, baseInput());
    expect(result).toEqual({ recorded: false, reason: "issue_not_assigned_to_agent" });
    expect(state.activity).toEqual([]);
  });

  it("does not overwrite a status a person sets while the run is finishing", async () => {
    const { state, deps } = makeWorld();
    state.changeBeforeMove = () => {
      state.issue.status = "blocked";
    };
    const result = await applyAdapterReplyOutcome(deps, baseInput());
    expect(result).toEqual({ recorded: false, reason: "issue_changed_concurrently" });
    expect(state.issue.status).toBe("blocked");
    expect(state.moves).toEqual([]);
    expect(state.activity).toEqual([]);
  });
});

describe("what disposition repair does afterwards", () => {
  const run = { id: "run-1", companyId: COMPANY_ID, agentId: AGENT_ID, status: "succeeded", runtimeMode: null };
  const agent = { id: AGENT_ID, companyId: COMPANY_ID, status: "idle" };
  const gates = {
    stopped: false,
    paused: false,
    budgetBlocked: false,
    pendingWait: false,
    activeExecution: false,
    ownedLifecycle: false,
    conversation: false,
    agentInvokable: true,
  };
  const episode = { id: "episode-1", attempt: 0, maxAttempts: 2 };
  const decide = (status: string) =>
    decideLegacyContinuation({
      run,
      issue: { id: "issue-1", companyId: COMPANY_ID, status, assigneeAgentId: AGENT_ID },
      agent,
      episode,
      gates,
    });

  it("today, with the task left in progress, schedules a repair wake (the defect)", () => {
    expect(decide("in_progress").kind).toBe("enqueue");
  });

  it("queues no repair wake once the reply is recorded as done or in_review", () => {
    expect(decide("done")).toEqual({ kind: "skip", reason: "recorded_disposition" });
    expect(decide("in_review")).toEqual({ kind: "skip", reason: "recorded_disposition" });
  });

  it("never reaches unchanged_source_state_exhausted: repair does not run for a recorded task", () => {
    const exhaustedEpisode = { id: "episode-1", attempt: 2, maxAttempts: 2 };
    const inProgress = decideLegacyContinuation({
      run, agent, gates, episode: exhaustedEpisode,
      issue: { id: "issue-1", companyId: COMPANY_ID, status: "in_progress", assigneeAgentId: AGENT_ID },
    });
    expect(inProgress.kind).toBe("exhausted");
    const recorded = decideLegacyContinuation({
      run, agent, gates, episode: exhaustedEpisode,
      issue: { id: "issue-1", companyId: COMPANY_ID, status: "done", assigneeAgentId: AGENT_ID },
    });
    expect(recorded.kind).toBe("skip");
  });
});

describe("why done is the default status", () => {
  const input = (issue: Record<string, unknown>) => ({
    issues: [],
    relations: [],
    agents: [{ id: AGENT_ID, companyId: COMPANY_ID, name: "Fred", role: "general", status: "idle" }],
    now: new Date("2026-10-21T00:00:00.000Z"),
    ...{ issue },
  });
  const issue = (extra: Record<string, unknown> = {}) => ({
    id: "issue-1",
    companyId: COMPANY_ID,
    identifier: "WIL-1",
    title: "Task",
    status: "in_review",
    assigneeAgentId: AGENT_ID,
    ...extra,
  });

  it("an in_review task assigned only to the agent has no maintained review path (treated as stalled)", () => {
    const i = issue();
    expect(classifyIssueReviewPaths(input(i) as never, i as never)).toEqual([]);
  });

  it("an in_review task with a human assignee does have one", () => {
    const i = issue({ assigneeAgentId: null, assigneeUserId: "user-1" });
    const paths = classifyIssueReviewPaths(input(i) as never, i as never);
    expect(paths.map((path) => path.kind)).toEqual(["human_reviewer"]);
  });
});

describe("adapter capability flag", () => {
  it("only the Hermes Gateway adapter declares recordsOutcomeForAgent", async () => {
    const { getServerAdapter } = await import("../adapters/registry.ts");
    expect(getServerAdapter("hermes_gateway").recordsOutcomeForAgent).toBe(true);
    for (const type of ["claude_local", "codex_local", "hermes_local", "openclaw_gateway"]) {
      expect(getServerAdapter(type).recordsOutcomeForAgent).not.toBe(true);
    }
  });
});
