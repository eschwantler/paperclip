import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Per-agent store for Claude Code conversation files.
 *
 * A managed AI connection gives every run a fresh temporary home that is deleted when the run
 * ends, so the `<sessionId>.jsonl` file that `claude --resume` needs vanishes with it. This store
 * copies the file into the new home before a run and back out afterwards. Every function is
 * best-effort: on any failure the caller falls back to today's behaviour (a fresh session).
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORE_DIR_NAME = "sessions";
const DEFAULT_TTL_DAYS = 14;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Mirrors Claude Code's project-dir encoding: non-alphanumeric chars become "-"; hyphens pass through. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function resolveClaudeSessionStoreRoot(runtimeStateDir: string): string {
  return path.join(runtimeStateDir, STORE_DIR_NAME);
}

export function resolveClaudeSessionStoreTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.PAPERCLIP_CLAUDE_SESSION_STORE_TTL_DAYS);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

export function shouldUseClaudeSessionStore(input: {
  /** `context.paperclipPersistManagedClaudeSessions`, set by the server from the instance setting. */
  contextFlag: unknown;
  managedAiConnection: unknown;
  executionTargetIsRemote: boolean;
  /** Per-agent opt-out: `persistManagedSessions: false` in the adapter config. */
  persistManagedSessions: unknown;
}): boolean {
  return (
    input.contextFlag === true &&
    Boolean(input.managedAiConnection) &&
    !input.executionTargetIsRemote &&
    input.persistManagedSessions !== false
  );
}

export function isClaudeSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function copyFileAtomic(src: string, dest: string): Promise<boolean> {
  if (!(await exists(src))) return false;
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: DIR_MODE });
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(src, tmp);
    await fs.chmod(tmp, FILE_MODE);
    await fs.rename(tmp, dest);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

async function copyDirIfExists(src: string, dest: string): Promise<void> {
  if (!(await exists(src))) return;
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: DIR_MODE });
  await fs.cp(src, dest, { recursive: true });
}

interface SessionLocation {
  cwd: string;
  sessionId: string;
}

/** Copy a stored conversation into the run's Claude config dir. Returns true when one was restored. */
export async function restoreClaudeSession(input: SessionLocation & {
  storeRoot: string;
  claudeConfigDir: string;
}): Promise<boolean> {
  if (!isClaudeSessionId(input.sessionId)) return false;
  const encoded = encodeClaudeProjectDir(input.cwd);
  const from = path.join(input.storeRoot, encoded);
  const to = path.join(input.claudeConfigDir, "projects", encoded);
  const restored = await copyFileAtomic(
    path.join(from, `${input.sessionId}.jsonl`),
    path.join(to, `${input.sessionId}.jsonl`),
  );
  if (restored) {
    await copyDirIfExists(path.join(from, input.sessionId), path.join(to, input.sessionId));
    // Keep the entry fresh so an actively used session is not pruned.
    const now = new Date();
    await fs.utimes(path.join(from, `${input.sessionId}.jsonl`), now, now).catch(() => {});
  }
  return restored;
}

/** Copy the run's conversation out of its Claude config dir. Returns true when one was saved. */
export async function saveClaudeSession(input: SessionLocation & {
  storeRoot: string;
  claudeConfigDir: string;
}): Promise<boolean> {
  if (!isClaudeSessionId(input.sessionId)) return false;
  const encoded = encodeClaudeProjectDir(input.cwd);
  const from = path.join(input.claudeConfigDir, "projects", encoded);
  const to = path.join(input.storeRoot, encoded);
  await fs.mkdir(input.storeRoot, { recursive: true, mode: DIR_MODE });
  const saved = await copyFileAtomic(
    path.join(from, `${input.sessionId}.jsonl`),
    path.join(to, `${input.sessionId}.jsonl`),
  );
  if (saved) {
    await copyDirIfExists(path.join(from, input.sessionId), path.join(to, input.sessionId));
  }
  return saved;
}

/** Drop a stored conversation, for example after Paperclip clears the task's session. */
export async function removeStoredClaudeSession(input: SessionLocation & { storeRoot: string }): Promise<void> {
  if (!isClaudeSessionId(input.sessionId)) return;
  const dir = path.join(input.storeRoot, encodeClaudeProjectDir(input.cwd));
  await fs.rm(path.join(dir, `${input.sessionId}.jsonl`), { force: true });
  await fs.rm(path.join(dir, input.sessionId), { recursive: true, force: true });
}

/** Delete stored conversations that have not been touched within `maxAgeMs`. Returns how many were removed. */
export async function pruneClaudeSessionStore(storeRoot: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(storeRoot);
  } catch {
    return 0;
  }
  for (const projectDir of projectDirs) {
    const dir = path.join(storeRoot, projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      try {
        const stat = await fs.stat(path.join(dir, entry));
        if (now - stat.mtimeMs <= maxAgeMs) continue;
        await fs.rm(path.join(dir, entry), { force: true });
        if (isClaudeSessionId(sessionId)) {
          await fs.rm(path.join(dir, sessionId), { recursive: true, force: true });
        }
        removed += 1;
      } catch {
        // best-effort pruning
      }
    }
  }
  return removed;
}
