import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";

const logActivity = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../services/activity-log.js", () => ({ logActivity }));

import { memoryHydrateService } from "../services/memory-hydrate.js";

const request = { companyId: "c1", agentId: "a1", issueId: "i1", runId: "r1", query: "ISMS review" };
const provider = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  pluginKey: `memory.${id}`,
  status: "ready",
  manifestJson: { memoryProvider: { name: "Mem", description: "Mem" }, capabilities: ["memory.hydrate"], ...extra },
});
const dbWith = (rows: unknown[]) => ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as never;
const manager = (call: ReturnType<typeof vi.fn>, running = true) => ({ isRunning: () => running, call }) as never;

describe("memoryHydrateService", () => {
  beforeEach(() => logActivity.mockClear());

  it("returns null without a worker manager or a ready memory provider", async () => {
    expect(await memoryHydrateService(dbWith([provider("p1")])).hydrate(request)).toBeNull();
    expect(await memoryHydrateService(dbWith([]), manager(vi.fn())).hydrate(request)).toBeNull();
    expect(await memoryHydrateService(dbWith([provider("p1", { memoryProvider: undefined })]), manager(vi.fn())).hydrate(request)).toBeNull();
    expect(await memoryHydrateService(dbWith([provider("p1")]), manager(vi.fn(), false)).hydrate(request)).toBeNull();
  });

  it("merges validated snippets and logs counts, never the recalled text", async () => {
    const call = vi.fn(async () => ({ snippets: [{ text: "secret-ish note", source: "team-shared" }], profileSummary: "P" }));
    const result = await memoryHydrateService(dbWith([provider("p1")]), manager(call)).hydrate(request);
    expect(call).toHaveBeenCalledWith("p1", "preRunHydrate", request, 3000);
    expect(result).toEqual({ snippets: [{ text: "secret-ish note", source: "team-shared" }], profileSummary: "P" });
    const logged = JSON.stringify(logActivity.mock.calls);
    expect(logged).toContain("memory.hydrated");
    expect(logged).toContain('"snippetCount":1');
    expect(logged).not.toContain("secret-ish note");
  });

  it("never throws: a failing or malformed provider yields a partial result and a failed log entry", async () => {
    const failing = vi.fn(async () => { throw new Error("hindsight down"); });
    const failed = await memoryHydrateService(dbWith([provider("p1")]), manager(failing)).hydrate(request);
    expect(failed).toEqual({ snippets: [], partial: true });
    expect(JSON.stringify(logActivity.mock.calls)).toContain('"outcome":"failed"');

    const malformed = vi.fn(async () => ({ snippets: [{ text: "" }] }));
    expect(await memoryHydrateService(dbWith([provider("p1")]), manager(malformed)).hydrate(request)).toEqual({ snippets: [], partial: true });
  });

  it("still returns the run when the activity log write fails", async () => {
    logActivity.mockRejectedValueOnce(new Error("db down"));
    const call = vi.fn(async () => ({ snippets: [{ text: "ok" }] }));
    const result = await memoryHydrateService(dbWith([provider("p1")]), manager(call)).hydrate(request);
    expect(result?.snippets).toHaveLength(1);
  });
});

describe("memoryProvider manifest", () => {
  const base = {
    id: "acme.memory", apiVersion: 1, version: "1.0.0", displayName: "Memory", description: "Recall",
    author: "acme", categories: ["connector"], entrypoints: { worker: "dist/worker.js" },
  };
  it("requires the memory.hydrate capability", () => {
    const withoutCap = pluginManifestV1Schema.safeParse({ ...base, capabilities: ["companies.read"], memoryProvider: { name: "M", description: "D" } });
    expect(withoutCap.success).toBe(false);
    const withCap = pluginManifestV1Schema.safeParse({ ...base, capabilities: ["memory.hydrate"], memoryProvider: { name: "M", description: "D" } });
    expect(withCap.success).toBe(true);
  });
});
