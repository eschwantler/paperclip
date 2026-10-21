import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeClaudeProjectDir,
  pruneClaudeSessionStore,
  removeStoredClaudeSession,
  resolveClaudeSessionStoreRoot,
  resolveClaudeSessionStoreTtlMs,
  restoreClaudeSession,
  saveClaudeSession,
  shouldUseClaudeSessionStore,
} from "./session-store.js";

const SESSION = "f2ff77f3-1c0a-4d6e-9b1f-0a1b2c3d4e5f";
const OTHER_SESSION = "0a1b2c3d-1111-4222-8333-444455556666";
const CWD = "/opt/n8n/2_Development/n8n workflow audits";

describe("claude session store", () => {
  let tmp: string;
  let storeRoot: string;
  let runOneHome: string;
  let runTwoHome: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-session-store-"));
    storeRoot = resolveClaudeSessionStoreRoot(path.join(tmp, "claude-runtime"));
    runOneHome = path.join(tmp, "run-one", "provider");
    runTwoHome = path.join(tmp, "run-two", "provider");
    await fs.mkdir(runOneHome, { recursive: true });
    await fs.mkdir(runTwoHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeConversation(home: string, sessionId: string, body: string) {
    const dir = path.join(home, "projects", encodeClaudeProjectDir(CWD));
    await fs.mkdir(path.join(dir, sessionId), { recursive: true });
    await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), body);
    await fs.writeFile(path.join(dir, sessionId, "sidecar.txt"), `side:${body}`);
  }

  it("encodes the cwd the way Claude Code does", () => {
    expect(encodeClaudeProjectDir("/opt/n8n/2_Development/n8n workflow audits")).toBe(
      "-opt-n8n-2-Development-n8n-workflow-audits",
    );
  });

  it("carries a conversation from one temporary home into the next", async () => {
    await writeConversation(runOneHome, SESSION, "turn-1");
    expect(await saveClaudeSession({ storeRoot, claudeConfigDir: runOneHome, cwd: CWD, sessionId: SESSION })).toBe(true);

    // The managed home is deleted after the run.
    await fs.rm(path.dirname(runOneHome), { recursive: true, force: true });

    expect(await restoreClaudeSession({ storeRoot, claudeConfigDir: runTwoHome, cwd: CWD, sessionId: SESSION })).toBe(true);
    const dir = path.join(runTwoHome, "projects", encodeClaudeProjectDir(CWD));
    expect(await fs.readFile(path.join(dir, `${SESSION}.jsonl`), "utf8")).toBe("turn-1");
    expect(await fs.readFile(path.join(dir, SESSION, "sidecar.txt"), "utf8")).toBe("side:turn-1");
  });

  it("keeps growing the stored copy across runs", async () => {
    await writeConversation(runOneHome, SESSION, "turn-1");
    await saveClaudeSession({ storeRoot, claudeConfigDir: runOneHome, cwd: CWD, sessionId: SESSION });
    await restoreClaudeSession({ storeRoot, claudeConfigDir: runTwoHome, cwd: CWD, sessionId: SESSION });
    await writeConversation(runTwoHome, SESSION, "turn-1+turn-2");
    await saveClaudeSession({ storeRoot, claudeConfigDir: runTwoHome, cwd: CWD, sessionId: SESSION });

    const stored = path.join(storeRoot, encodeClaudeProjectDir(CWD), `${SESSION}.jsonl`);
    expect(await fs.readFile(stored, "utf8")).toBe("turn-1+turn-2");
  });

  it("reports nothing restored when the store has no copy, so Paperclip starts fresh as today", async () => {
    expect(await restoreClaudeSession({ storeRoot, claudeConfigDir: runTwoHome, cwd: CWD, sessionId: SESSION })).toBe(false);
    await expect(fs.stat(path.join(runTwoHome, "projects"))).rejects.toThrow();
  });

  it("saves nothing when the run produced no conversation file", async () => {
    expect(await saveClaudeSession({ storeRoot, claudeConfigDir: runOneHome, cwd: CWD, sessionId: SESSION })).toBe(false);
  });

  it("refuses session ids that are not UUIDs (no path traversal)", async () => {
    const evil = "../../../etc/passwd";
    expect(await saveClaudeSession({ storeRoot, claudeConfigDir: runOneHome, cwd: CWD, sessionId: evil })).toBe(false);
    expect(await restoreClaudeSession({ storeRoot, claudeConfigDir: runTwoHome, cwd: CWD, sessionId: evil })).toBe(false);
    await removeStoredClaudeSession({ storeRoot, cwd: CWD, sessionId: evil });
  });

  it("writes private files and folders", async () => {
    await writeConversation(runOneHome, SESSION, "turn-1");
    await saveClaudeSession({ storeRoot, claudeConfigDir: runOneHome, cwd: CWD, sessionId: SESSION });
    const dir = path.join(storeRoot, encodeClaudeProjectDir(CWD));
    expect((await fs.stat(path.join(dir, `${SESSION}.jsonl`))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(storeRoot)).mode & 0o777).toBe(0o700);
  });

  it("removes a stored conversation and its sidecar folder", async () => {
    await writeConversation(runOneHome, SESSION, "turn-1");
    await saveClaudeSession({ storeRoot, claudeConfigDir: runOneHome, cwd: CWD, sessionId: SESSION });
    await removeStoredClaudeSession({ storeRoot, cwd: CWD, sessionId: SESSION });
    expect(await restoreClaudeSession({ storeRoot, claudeConfigDir: runTwoHome, cwd: CWD, sessionId: SESSION })).toBe(false);
  });

  it("prunes only conversations older than the limit", async () => {
    await writeConversation(runOneHome, SESSION, "old");
    await writeConversation(runOneHome, OTHER_SESSION, "fresh");
    await saveClaudeSession({ storeRoot, claudeConfigDir: runOneHome, cwd: CWD, sessionId: SESSION });
    await saveClaudeSession({ storeRoot, claudeConfigDir: runOneHome, cwd: CWD, sessionId: OTHER_SESSION });
    const dir = path.join(storeRoot, encodeClaudeProjectDir(CWD));
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(dir, `${SESSION}.jsonl`), thirtyDaysAgo, thirtyDaysAgo);

    expect(await pruneClaudeSessionStore(storeRoot, resolveClaudeSessionStoreTtlMs({}))).toBe(1);
    await expect(fs.stat(path.join(dir, `${SESSION}.jsonl`))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, SESSION))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, `${OTHER_SESSION}.jsonl`))).resolves.toBeTruthy();
  });

  it("does not throw when the store does not exist yet", async () => {
    expect(await pruneClaudeSessionStore(path.join(tmp, "missing"), 1000)).toBe(0);
  });

  it("reads the retention period from the environment, defaulting to 14 days", () => {
    expect(resolveClaudeSessionStoreTtlMs({})).toBe(14 * 24 * 60 * 60 * 1000);
    expect(resolveClaudeSessionStoreTtlMs({ PAPERCLIP_CLAUDE_SESSION_STORE_TTL_DAYS: "2" })).toBe(2 * 24 * 60 * 60 * 1000);
    expect(resolveClaudeSessionStoreTtlMs({ PAPERCLIP_CLAUDE_SESSION_STORE_TTL_DAYS: "nope" })).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe("shouldUseClaudeSessionStore", () => {
  const on = {
    contextFlag: true,
    managedAiConnection: { id: "conn" },
    executionTargetIsRemote: false,
    persistManagedSessions: undefined,
  };

  it("is on only when the setting, a managed connection and a local target all line up", () => {
    expect(shouldUseClaudeSessionStore(on)).toBe(true);
  });

  it("is off when the instance setting is off or missing (today's behaviour)", () => {
    expect(shouldUseClaudeSessionStore({ ...on, contextFlag: false })).toBe(false);
    expect(shouldUseClaudeSessionStore({ ...on, contextFlag: undefined })).toBe(false);
  });

  it("is off without a managed connection", () => {
    expect(shouldUseClaudeSessionStore({ ...on, managedAiConnection: undefined })).toBe(false);
  });

  it("is off for remote execution targets", () => {
    expect(shouldUseClaudeSessionStore({ ...on, executionTargetIsRemote: true })).toBe(false);
  });

  it("honours the per-agent opt-out", () => {
    expect(shouldUseClaudeSessionStore({ ...on, persistManagedSessions: false })).toBe(false);
    expect(shouldUseClaudeSessionStore({ ...on, persistManagedSessions: true })).toBe(true);
  });
});
