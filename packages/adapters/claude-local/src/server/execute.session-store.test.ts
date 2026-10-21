import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the real execute() CLI path with a fake `claude` process that behaves like the real one
 * on --resume: it only finds a conversation if <CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<id>.jsonl
 * exists, and it writes that file when a session runs. Every run gets a brand-new config dir, as a
 * managed AI connection does.
 */

interface FakeClaudeCall {
  resumeId: string | null;
  hadConversationFile: boolean;
  configDir: string;
  cwd: string;
}

const { fakeClaude, calls } = vi.hoisted(() => {
  const calls: Array<{ resumeId: string | null; hadConversationFile: boolean; configDir: string; cwd: string }> = [];
  return { fakeClaude: { next: null as null | ((call: FakeClaudeCall) => Promise<unknown>) }, calls };
});

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess: vi.fn(
      async (_runId: string, _target: unknown, _command: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => {
        const resumeIdx = args.indexOf("--resume");
        const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
        const configDir = opts.env.CLAUDE_CONFIG_DIR;
        const encoded = opts.cwd.replace(/[^a-zA-Z0-9-]/g, "-");
        const projectDir = path.join(configDir, "projects", encoded);
        const exists = async (p: string) => fs.stat(p).then(() => true, () => false);
        const hadConversationFile = resumeId ? await exists(path.join(projectDir, `${resumeId}.jsonl`)) : false;
        const call: FakeClaudeCall = { resumeId, hadConversationFile, configDir, cwd: opts.cwd };
        calls.push(call);

        const result = (sessionId: string, text: string, isError: boolean) => ({
          exitCode: isError ? 1 : 0,
          signal: null,
          timedOut: false,
          stdout: [
            JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }),
            JSON.stringify({
              type: "result",
              subtype: isError ? "error" : "success",
              is_error: isError,
              session_id: sessionId,
              result: text,
              usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
            }),
          ].join("\n"),
          stderr: "",
          pid: 123,
          startedAt: new Date().toISOString(),
        });

        if (resumeId && !hadConversationFile) {
          return result(resumeId, `No conversation found with session ID: ${resumeId}`, true);
        }
        const sessionId = resumeId ?? randomUUID();
        await fs.mkdir(path.join(projectDir, sessionId), { recursive: true });
        await fs.appendFile(path.join(projectDir, `${sessionId}.jsonl`), `turn@${calls.length}\n`);
        return result(sessionId, "ok", false);
      },
    ),
  };
});

import { execute } from "./execute.js";

describe("claude_local execute() with the persistent session store", () => {
  let tmp: string;
  let workspace: string;
  let paperclipHome: string;
  let runCount: number;

  beforeEach(async () => {
    calls.length = 0;
    runCount = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-execute-session-store-"));
    workspace = path.join(tmp, "workspace");
    paperclipHome = path.join(tmp, "paperclip-home");
    await fs.mkdir(workspace, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** One heartbeat run: a fresh temporary managed home each time, like a managed AI connection. */
  async function runOnce(input: {
    persist?: boolean | undefined;
    sessionId?: string | null;
    sessionCwd?: string;
    configExtra?: Record<string, unknown>;
  }) {
    runCount += 1;
    const managedHome = path.join(tmp, `managed-home-${runCount}`, "provider");
    await fs.mkdir(managedHome, { recursive: true });
    const logs: string[] = [];
    const result = await execute({
      runId: `run-${runCount}`,
      agent: { id: "agent-1", companyId: "company-1", name: "n8n", adapterType: "claude_local", adapterConfig: {} },
      runtime: {
        sessionId: input.sessionId ?? null,
        sessionParams: input.sessionId ? { sessionId: input.sessionId, cwd: input.sessionCwd ?? "" } : null,
        sessionDisplayId: null,
        taskKey: "issue-1",
      },
      config: {
        engine: "cli",
        cwd: workspace,
        managedAiConnection: { provider: "anthropic" },
        env: { CLAUDE_CONFIG_DIR: managedHome },
        ...input.configExtra,
      },
      context: input.persist === undefined ? {} : { paperclipPersistManagedClaudeSessions: input.persist },
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    } as never);
    return { result, logs: logs.join(""), managedHome };
  }

  const storedFiles = async () => {
    const root = path.join(paperclipHome, "instances", "test", "companies", "company-1", "agents", "agent-1", "claude-runtime", "sessions");
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".jsonl")) out.push(entry.name);
      }
    };
    await walk(root);
    return out;
  };

  it("resumes the same Claude conversation in a brand-new managed home when the setting is on", async () => {
    const first = await runOnce({ persist: true });
    const sessionId = (first.result as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();
    expect(first.logs).toContain(`Saved Claude session ${sessionId}`);
    expect(await storedFiles()).toEqual([`${sessionId}.jsonl`]);

    const second = await runOnce({ persist: true, sessionId, sessionCwd: calls[0].cwd });

    expect(second.logs).toContain(`Restored Claude session ${sessionId}`);
    expect(second.logs).not.toContain("retrying with a fresh session");
    expect(calls[1]).toMatchObject({ resumeId: sessionId, hadConversationFile: true });
    expect(calls[1].configDir).not.toBe(calls[0].configDir);
    expect((second.result as { sessionId: string }).sessionId).toBe(sessionId);
    // the conversation keeps growing across wakes
    const third = await runOnce({ persist: true, sessionId, sessionCwd: calls[0].cwd });
    expect((third.result as { sessionId: string }).sessionId).toBe(sessionId);
    const stored = await fs.readFile(
      path.join(
        paperclipHome, "instances", "test", "companies", "company-1", "agents", "agent-1", "claude-runtime", "sessions",
        calls[0].cwd.replace(/[^a-zA-Z0-9-]/g, "-"), `${sessionId}.jsonl`,
      ),
      "utf8",
    );
    expect(stored.trim().split("\n")).toHaveLength(3);
  });

  it("behaves exactly as before when the setting is off: nothing stored, resume falls back to a fresh session", async () => {
    const first = await runOnce({ persist: false });
    const sessionId = (first.result as { sessionId: string }).sessionId;
    expect(await storedFiles()).toEqual([]);

    const second = await runOnce({ persist: false, sessionId, sessionCwd: calls[0].cwd });
    expect(second.logs).toContain("retrying with a fresh session");
    expect(second.logs).not.toContain("Restored Claude session");
    expect((second.result as { sessionId: string }).sessionId).not.toBe(sessionId);
  });

  it("does nothing when the instance setting is missing from the run context", async () => {
    await runOnce({});
    expect(await storedFiles()).toEqual([]);
  });

  it("lets one agent opt out with persistManagedSessions: false", async () => {
    await runOnce({ persist: true, configExtra: { persistManagedSessions: false } });
    expect(await storedFiles()).toEqual([]);
  });

  it("does not store anything without a managed AI connection", async () => {
    await runOnce({ persist: true, configExtra: { managedAiConnection: undefined } });
    expect(await storedFiles()).toEqual([]);
  });

  it("falls back to a fresh session cleanly when the stored copy has gone, and drops the stale entry", async () => {
    const first = await runOnce({ persist: true });
    const oldSession = (first.result as { sessionId: string }).sessionId;
    const sessionsRoot = path.join(paperclipHome, "instances", "test", "companies", "company-1", "agents", "agent-1", "claude-runtime", "sessions");
    await fs.rm(sessionsRoot, { recursive: true, force: true });

    const second = await runOnce({ persist: true, sessionId: oldSession, sessionCwd: calls[0].cwd });

    expect(second.logs).toContain("retrying with a fresh session");
    const newSession = (second.result as { sessionId: string }).sessionId;
    expect(newSession).not.toBe(oldSession);
    expect(await storedFiles()).toEqual([`${newSession}.jsonl`]);
  });

  it("keeps a single stored entry after a successful resume", async () => {
    const first = await runOnce({ persist: true });
    const sessionId = (first.result as { sessionId: string }).sessionId;
    const second = await runOnce({ persist: true, sessionId, sessionCwd: calls[0].cwd });
    expect((second.result as { sessionId: string }).sessionId).toBe(sessionId);
    expect(await storedFiles()).toEqual([`${sessionId}.jsonl`]);
  });
});
