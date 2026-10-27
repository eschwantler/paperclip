import { describe, expect, it, vi } from "vitest";
import { agentSlug, resolveBanks } from "../src/banks.js";
import { parseConfig } from "../src/config.js";
import { hydrate } from "../src/hydrate.js";

const config = parseConfig({
  baseUrl: "http://hindsight.test:8888/",
  apiKey: "key-123",
  agentTopics: { "n8n-agent": ["n8n", "isms"] },
});
const request = { companyId: "c1", agentId: "a1", issueId: "i1", runId: "r1", query: "ISMS review" };

type Call = { url: string; body: Record<string, unknown>; auth: string | null };
function fakeHindsight(reply: (bank: string, call: Call) => { status?: number; results?: unknown[] }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const call: Call = {
      url: href,
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const bank = decodeURIComponent(href.split("/banks/")[1]!.split("/")[0]!);
    const { status = 200, results = [] } = reply(bank, call);
    return new Response(status === 200 ? JSON.stringify({ results }) : "internal detail", { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("config", () => {
  it("refuses to run without a URL or an API key", () => {
    expect(() => parseConfig({ apiKey: "k" })).toThrow(/base URL/);
    expect(() => parseConfig({ baseUrl: "http://h" })).toThrow(/API key/);
    expect(() => parseConfig({ baseUrl: "http://h", apiKey: "  " })).toThrow(/API key/);
  });
  it("strips trailing slashes and applies defaults", () => {
    expect(config.baseUrl).toBe("http://hindsight.test:8888");
    expect(config.sharedBank).toBe("team-shared");
    expect(config.agentBankPrefix).toBe("agent-");
  });
});

describe("bank resolution", () => {
  it("derives a bank-safe slug from the agent name", () => {
    expect(agentSlug("N8N Agent!")).toBe("n8n-agent");
    expect(() => resolveBanks("!!!", config)).toThrow();
  });
  it("reads the agent's own bank and a tag-filtered slice of the shared bank", () => {
    expect(resolveBanks("n8n agent", config)).toEqual({
      own: "agent-n8n-agent",
      shared: "team-shared",
      sharedTags: ["for:n8n-agent", "topic:n8n", "topic:isms"],
    });
    expect(resolveBanks("Fred", config).sharedTags).toEqual(["for:fred"]);
  });
});

describe("hydrate", () => {
  it("recalls from both banks, filters the shared one, authenticates, and never sends a write", async () => {
    const { calls, fetchImpl } = fakeHindsight((bank) => ({
      results: bank === "agent-n8n-agent"
        ? [{ id: "m1", text: "Retry the webhook twice." }]
        : [{ id: "m2", text: "DPA retention is now 24 months." }],
    }));
    const result = await hydrate({ request, agentName: "n8n agent", config, fetchImpl });
    expect(result.snippets).toEqual([
      { text: "Retry the webhook twice.", source: "agent-n8n-agent", recordId: "m1" },
      { text: "DPA retention is now 24 months.", source: "team-shared", recordId: "m2" },
    ]);
    expect(result.partial).toBeUndefined();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toMatch(/\/memories\/recall$/);
      expect(call.auth).toBe("Bearer key-123");
    }
    const own = calls.find((call) => call.url.includes("agent-n8n-agent"))!;
    const shared = calls.find((call) => call.url.includes("team-shared"))!;
    expect(own.body.tags).toBeUndefined();
    expect(shared.body).toMatchObject({ tags: ["for:n8n-agent", "topic:n8n", "topic:isms"], tags_match: "any_strict" });
  });

  it("treats a missing bank as empty, not as an outage", async () => {
    const { fetchImpl } = fakeHindsight((bank) =>
      bank === "agent-n8n-agent" ? { status: 404 } : { results: [{ id: "m2", text: "Shared fact." }] });
    const result = await hydrate({ request, agentName: "n8n agent", config, fetchImpl });
    expect(result.snippets).toHaveLength(1);
    expect(result.partial).toBeUndefined();
  });

  it("marks recall partial when one bank errors, so an empty result is not read as no memory", async () => {
    const { fetchImpl } = fakeHindsight((bank) =>
      bank === "team-shared" ? { status: 500 } : { results: [{ id: "m1", text: "Own fact." }] });
    const result = await hydrate({ request, agentName: "n8n agent", config, fetchImpl });
    expect(result).toEqual({ snippets: [{ text: "Own fact.", source: "agent-n8n-agent", recordId: "m1" }], partial: true });
  });

  it("throws when every bank fails, without leaking the response body", async () => {
    const { fetchImpl } = fakeHindsight(() => ({ status: 500 }));
    const error = await hydrate({ request, agentName: "n8n agent", config, fetchImpl }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("internal detail");
  });

  it("skips recall without a query and de-duplicates identical text across banks", async () => {
    const never = fakeHindsight(() => ({}));
    expect(await hydrate({ request: { ...request, query: null }, agentName: "Fred", config, fetchImpl: never.fetchImpl })).toEqual({ snippets: [] });
    expect(never.calls).toHaveLength(0);

    const dup = fakeHindsight(() => ({ results: [{ id: "x", text: "Same fact." }] }));
    const result = await hydrate({ request, agentName: "Fred", config, fetchImpl: dup.fetchImpl });
    expect(result.snippets).toHaveLength(1);
  });

  it("caps snippet length", async () => {
    const { fetchImpl } = fakeHindsight(() => ({ results: [{ id: "big", text: "x".repeat(5000) }] }));
    const result = await hydrate({ request, agentName: "Fred", config, fetchImpl });
    expect(result.snippets[0]!.text).toHaveLength(2000);
  });
});
