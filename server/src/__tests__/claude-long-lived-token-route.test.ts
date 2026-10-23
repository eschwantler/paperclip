import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { createDb, companies, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";

vi.mock("@paperclipai/adapter-claude-local/server", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  probeClaudeLongLivedToken: vi.fn(),
}));

import { probeClaudeLongLivedToken } from "@paperclipai/adapter-claude-local/server";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { aiConnectionService } from "../services/ai-connections.js";

const probe = vi.mocked(probeClaudeLongLivedToken);
const token = "sk-ant-oat01-" + "Z".repeat(95);
const companyId = randomUUID();
const user = "token-user";
const manager = "token-manager";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

function appFor(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] } as typeof req.actor;
    next();
  });
  app.use("/api", aiConnectionRoutes(db));
  app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
  return app;
}
const body = (extra: Record<string, unknown> = {}) => ({ provider: "anthropic", method: "subscription", name: "Token test", ownership: "personal", agentIds: [], allAgents: false, setupToken: token, ...extra });
const post = (userId: string, payload: unknown) => request(appFor(userId)).post(`/api/companies/${companyId}/ai-connections/local`).send(payload as object);
const listed = async (userId: string) => (await request(appFor(userId)).get(`/api/companies/${companyId}/ai-connections`)).body;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-token-route-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "token-route-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-token-route-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Token tests", issuePrefix: "TOK" });
  await db.insert(companyMemberships).values([user, manager].map((principalId) => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
  await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: manager, permissionKey: "tools:manage_connections" });
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
beforeEach(() => { probe.mockReset(); });

describe("POST /ai-connections/local with a pasted Claude token", () => {
  it("saves a personal connection when the CLI probe passes, and never echoes the token", async () => {
    probe.mockResolvedValue(true);
    const response = await post(user, body({ name: "Personal token" }));
    expect(response.status).toBe(201);
    expect(probe).toHaveBeenCalledWith(token);
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(JSON.stringify(await listed(user))).not.toContain(token);
    expect(JSON.stringify(await listed(user))).toContain("Personal token");
  });

  it("rejects a token the CLI does not accept and saves nothing", async () => {
    probe.mockResolvedValue(false);
    const before = JSON.stringify(await listed(user));
    const response = await post(user, body({ name: "Rejected token" }));
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(JSON.stringify(await listed(user))).toBe(before);
  });

  it("refuses other providers and a token combined with a local sign-in, without probing", async () => {
    expect((await post(user, body({ provider: "openai" }))).status).toBe(422);
    expect((await post(user, body({ localSessionId: randomUUID() }))).status).toBe(422);
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a malformed token at validation, without probing", async () => {
    expect((await post(user, body({ setupToken: "short" }))).status).toBeGreaterThanOrEqual(400);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not let a non-manager create a shared connection", async () => {
    probe.mockResolvedValue(true);
    expect((await post(user, body({ ownership: "shared", name: "Not allowed" }))).status).toBe(403);
  });

  it("reconnects an existing shared connection in place, keeping its ids", async () => {
    const existing = await aiConnectionService(db).save(companyId, manager, { provider: "anthropic", method: "subscription", ownership: "shared", name: "Claude3 stand-in", loginSessionId: "fixture", agentIds: [], allAgents: true }, "old-short-lived-token");
    probe.mockResolvedValue(true);
    const response = await post(manager, body({ ownership: "shared", name: "Claude3 stand-in", connectionId: existing.connectionId }));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ connectionId: existing.connectionId, grantId: existing.grantId });
    expect(JSON.stringify(response.body)).not.toContain(token);
  });
});
