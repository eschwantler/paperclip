import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export function automaticRepositoryFiles(nonce: string) {
  return { context: `setup-context-${nonce}.txt`, result: `repository-result-${nonce}.json`, reference: `REFERENCE-${nonce}` };
}

export const automaticRepositoryTask: RunnerTaskFixture = {
  id: "automatic-repository-resume", label: "Repository preparation continues without supervision", groups: [],
  flow: "automatic_repository", workMode: "standard", expectedRunCount: 2,
  automaticRetryPolicy: "single_attempt", attemptTimeoutMs: { local: 12 * 60_000, daytona: 15 * 60_000 },
  turnTimeoutMs: 5 * 60_000, expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Verify a managed repository ${nonce}`,
  buildVisibleMarker: nonce => automaticRepositoryFiles(nonce).result,
  buildPrompt(nonce) {
    const files = automaticRepositoryFiles(nonce);
    return [
      "Verify a repository in this projectless task and deliver the result. Do not create a project or another task.",
      `Before repository setup, save ${files.context} in the task directory with exactly ${JSON.stringify(`${files.reference}\n`)}. The final newline is an actual LF.`,
      "Use the task's managed repository capability to prepare https://github.com/octocat/Hello-World. Keep the task directory as the root.",
      "When the checkout is ready, read its committed README and HEAD commit. Read the saved context file again; preserve its original reference.",
      `Write ${files.result} as JSON with exactly these fields: reference (the saved reference without its trailing LF), readme (the complete committed README bytes as text), and commit (the full HEAD SHA).`,
      `Register ${files.result} as a downloadable artifact work product with that exact title. Deliver its accessible link and finish the verification. Repository setup alone does not complete this request.`,
    ].join("\n");
  },
  buildMatchers: () => [],
};

export interface AutomaticRepositoryObservation {
  reference: string;
  issueDone: boolean;
  runCount: number;
  successfulCommittedRuns: number;
  sourceContinuation: string | null;
  successorSource: string | null;
  workspaceIds: Array<string | null>;
  readyRepository: boolean;
  savedContext: string | null;
  actualReadme: string | null;
  actualCommit: string | null;
  downloaded: { reference?: unknown; readme?: unknown; commit?: unknown } | null;
  downloadVerified: boolean;
  visibleDelivery: boolean;
  pendingInteractions: number;
  monitorScheduled: boolean;
}

export function gradeAutomaticRepository(value: AutomaticRepositoryObservation) {
  const check = (id: string, passed: boolean, detail: string) => ({ id, passed, detail });
  return [
    check("durable-completion", value.issueDone && value.runCount === 2 && value.successfulCommittedRuns === 2,
      "Two committed provider admissions must finish the requested result."),
    check("server-owned-continuation", value.sourceContinuation === "same_agent" && value.successorSource === "native_status_decision" && !value.monitorScheduled,
      "Repository setup must continue through the saved same-agent wake without a timer or user message."),
    check("retained-workspace", value.workspaceIds.length === 2 && Boolean(value.workspaceIds[0]) && value.workspaceIds.every(id => id === value.workspaceIds[0]) && value.readyRepository,
      "Both admissions must retain the same task workspace and its prepared repository."),
    check("retained-context", value.savedContext === `${value.reference}\n`, "The original task file must survive setup byte for byte."),
    check("independent-result", value.downloadVerified && value.downloaded !== null &&
      Object.keys(value.downloaded).sort().join(",") === "commit,readme,reference" && value.downloaded.reference === value.reference &&
      typeof value.actualReadme === "string" && value.actualReadme.length > 0 && value.downloaded?.readme === value.actualReadme &&
      typeof value.actualCommit === "string" && /^[a-f0-9]{40}$/.test(value.actualCommit) && value.downloaded?.commit === value.actualCommit,
      "Downloaded result bytes must agree with the independently inspected checkout and original reference."),
    check("accessible-delivery", value.visibleDelivery && value.pendingInteractions === 0, "The originating task must render its result link without an unanswered question."),
  ];
}

export function automaticRepositoryDigest() {
  const hash = createHash("sha256");
  for (const file of ["automatic-repository.ts", "automatic-repository-flow.ts", "registered-artifact.ts", "stock-harness.ts", "runner.spec.ts", "../../skills/paperclip/SKILL.md"])
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}
