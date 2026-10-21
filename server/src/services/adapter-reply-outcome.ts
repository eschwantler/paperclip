import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { logActivity } from "./activity-log.js";

/**
 * Some adapters give the agent no Paperclip API access by design (the Hermes Gateway adapter). Such an
 * agent can never set its own task status, so a successful reply looks to disposition repair like
 * "stopped without recording an outcome" and the agent is re-woken until the repair budget runs out.
 * When the adapter declares `recordsOutcomeForAgent` and returns a `reply_delivered` outcome, Paperclip
 * records the reply as the task's outcome on the agent's behalf.
 */

export const REPLY_OUTCOME_ACTIVITY_ACTION = "issue.outcome_recorded_by_adapter";
export const REPLY_OUTCOME_REASON = "gateway_reply_recorded_as_outcome";

export type ReplyOutcomeStatus = "in_review" | "done";

/**
 * `done` is the default: an `in_review` task assigned only to an agent has no maintained review path,
 * which Paperclip's review-path recovery treats as stalled and re-wakes the agent. `in_review` is for
 * tasks that also have a human reviewer.
 */
export function resolveReplyOutcomeStatus(runtimeConfig: unknown): ReplyOutcomeStatus {
  const raw =
    runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
      ? (runtimeConfig as Record<string, unknown>).replyOutcomeStatus
      : undefined;
  return raw === "in_review" ? "in_review" : "done";
}

export type ReplyOutcomeResult =
  | { recorded: true; status: ReplyOutcomeStatus }
  | { recorded: false; reason: string };

export interface ReplyOutcomeIssue {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
}

export interface ReplyOutcomeDeps {
  getIssue(issueId: string): Promise<ReplyOutcomeIssue | null>;
  alreadyRecorded(input: { issueId: string; runId: string; replyDigest: string }): Promise<boolean>;
  /** Move the issue, only if it is still in progress and assigned to the agent (the write must re-check). */
  moveIssue(input: {
    issueId: string;
    companyId: string;
    agentId: string;
    runId: string;
    status: ReplyOutcomeStatus;
  }): Promise<boolean>;
  logRecorded(input: {
    issue: ReplyOutcomeIssue;
    agentId: string;
    runId: string;
    status: ReplyOutcomeStatus;
    replyDigest: string;
  }): Promise<void>;
}

export interface ReplyOutcomeInput {
  /** The `enableGatewayReplyOutcome` experimental setting. */
  enabled: boolean;
  adapterRecordsOutcome: boolean;
  runSucceeded: boolean;
  outcome: AdapterExecutionResult["outcome"] | null | undefined;
  issueId: string | null;
  run: { id: string };
  agent: { id: string; runtimeConfig: unknown };
}

export async function applyAdapterReplyOutcome(
  deps: ReplyOutcomeDeps,
  input: ReplyOutcomeInput,
): Promise<ReplyOutcomeResult> {
  if (!input.enabled) return { recorded: false, reason: "setting_off" };
  if (!input.adapterRecordsOutcome) return { recorded: false, reason: "adapter_does_not_record_outcome" };
  if (!input.runSucceeded) return { recorded: false, reason: "run_not_successful" };
  if (!input.issueId) return { recorded: false, reason: "no_issue" };
  if (input.outcome?.kind !== "reply_delivered" || !input.outcome.replyDigest) {
    return { recorded: false, reason: "no_reply_outcome" };
  }
  const replyDigest = input.outcome.replyDigest;

  const issue = await deps.getIssue(input.issueId);
  if (!issue) return { recorded: false, reason: "issue_not_found" };
  // A person who changed the status or reassigned the task in the meantime wins.
  if (issue.status !== "in_progress") return { recorded: false, reason: "issue_not_in_progress" };
  if (issue.assigneeAgentId !== input.agent.id) return { recorded: false, reason: "issue_not_assigned_to_agent" };
  if (await deps.alreadyRecorded({ issueId: issue.id, runId: input.run.id, replyDigest })) {
    return { recorded: false, reason: "already_recorded" };
  }

  const status = resolveReplyOutcomeStatus(input.agent.runtimeConfig);
  const moved = await deps.moveIssue({
    issueId: issue.id,
    companyId: issue.companyId,
    agentId: input.agent.id,
    runId: input.run.id,
    status,
  });
  if (!moved) return { recorded: false, reason: "issue_changed_concurrently" };
  await deps.logRecorded({ issue, agentId: input.agent.id, runId: input.run.id, status, replyDigest });
  return { recorded: true, status };
}

type IssueMover = (
  issueId: string,
  data: { status: ReplyOutcomeStatus; actorAgentId: string; actorRunId: string; companyGuard: string },
) => Promise<unknown>;

export function createReplyOutcomeDeps(db: Db, updateIssue: IssueMover): ReplyOutcomeDeps {
  return {
    async getIssue(issueId) {
      const [row] = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1);
      return row ?? null;
    },
    async alreadyRecorded({ issueId, runId, replyDigest }) {
      const [row] = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.action, REPLY_OUTCOME_ACTIVITY_ACTION),
            eq(activityLog.entityId, issueId),
            eq(activityLog.runId, runId),
            sql`${activityLog.details} ->> 'replyDigest' = ${replyDigest}`,
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    async moveIssue({ issueId, companyId, agentId, runId, status }) {
      // Re-check in the write itself so a status change between the read and this update is not overwritten.
      const [current] = await db
        .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .limit(1);
      if (!current || current.status !== "in_progress" || current.assigneeAgentId !== agentId) return false;
      await updateIssue(issueId, { status, actorAgentId: agentId, actorRunId: runId, companyGuard: companyId });
      return true;
    },
    async logRecorded({ issue, agentId, runId, status, replyDigest }) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId,
        action: REPLY_OUTCOME_ACTIVITY_ACTION,
        entityType: "issue",
        entityId: issue.id,
        details: { status, replyDigest, reason: REPLY_OUTCOME_REASON },
      });
    },
  };
}
