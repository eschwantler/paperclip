import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeInstructionsForBundleKey, prepareClaudePromptBundle } from "./prompt-cache.js";

const directive = (runId: string) =>
  `Agent text\nThe above agent instructions were loaded from /home/e/.paperclip/instances/default/companies/c/agents/a/file-sync/runs/${runId}/live/AGENTS.md. ` +
  `Resolve any relative file references from /home/e/.paperclip/instances/default/companies/c/agents/a/file-sync/runs/${runId}/live/.`;

const RUN_A = "d8f89c2f-9020-4b5c-91b6-342e7bf58970";
const RUN_B = "eb1fc4b5-eb59-41a1-ab1e-68a503cfbe5e";

describe("claude prompt bundle key", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-bundle-key-"));
    vi.stubEnv("PAPERCLIP_HOME", tmp);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const keyFor = async (instructionsContents: string) =>
    (await prepareClaudePromptBundle({ companyId: "c", skills: [], instructionsContents, onLog: async () => {} })).bundleKey;

  it("is the same for two runs that differ only in the run-scoped file-sync path", async () => {
    expect(await keyFor(directive(RUN_A))).toBe(await keyFor(directive(RUN_B)));
  });

  it("still changes when the instructions themselves change", async () => {
    expect(await keyFor(directive(RUN_A))).not.toBe(await keyFor(directive(RUN_A).replace("Agent text", "Other text")));
  });

  it("only rewrites uuid run segments under file-sync/runs", () => {
    expect(normalizeInstructionsForBundleKey(`/x/file-sync/runs/${RUN_A}/live/a`)).toBe("/x/file-sync/runs/<run>/live/a");
    expect(normalizeInstructionsForBundleKey(`/x/runs/${RUN_A}/live`)).toBe(`/x/runs/${RUN_A}/live`);
    expect(normalizeInstructionsForBundleKey("/x/file-sync/runs/not-a-uuid/live")).toBe("/x/file-sync/runs/not-a-uuid/live");
  });
});
