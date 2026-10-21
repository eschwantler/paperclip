import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, mapFinalResultForTest } from "./execute.js";

function makeCtx(contextExtra: Record<string, unknown> = {}): AdapterExecutionContext {
  const config = { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "hermes-secret", timeoutSec: 5 };
  return {
    runId: "pc-run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_gateway", adapterConfig: config },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: { issue: { identifier: "PAP-1", title: "Do the thing" } },
      ...contextExtra,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const completedEvents = (output: string) =>
  new Response(
    sseStream(
      ["event: run.completed", `data: ${JSON.stringify({ status: "completed", output })}`, ""].join("\n"),
    ),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

function gatewayFetch(events: () => Response) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
    if (url.endsWith("/events")) return events();
    return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
  });
}

const terminal = (status: string, payload: Record<string, unknown> = {}, output?: string) => ({
  runId: "run-1",
  status,
  payload: { status, ...payload },
  ...(output !== undefined ? { output } : {}),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gateway reply outcome in the run result", () => {
  it("returns a reply_delivered outcome with the digest of a successful, non-empty reply", () => {
    const result = mapFinalResultForTest({
      terminal: terminal("completed", { output: "Here is the answer" }),
      outputChunks: [],
      sessionKey: "k",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toEqual({
      kind: "reply_delivered",
      replyDigest: createHash("sha256").update("Here is the answer").digest("hex"),
    });
  });

  it.each([
    ["failed", terminal("failed", { error: "boom", output: "partial text" })],
    ["error", terminal("error", { error: "boom", output: "partial text" })],
    ["cancelled", terminal("cancelled", { output: "partial text" })],
    ["an unknown status", terminal("weird", { output: "partial text" })],
  ])("returns no outcome when the run ended %s", (_label, term) => {
    const result = mapFinalResultForTest({ terminal: term, outputChunks: [], sessionKey: "k", strategy: "issue" });
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBeUndefined();
  });

  it("returns no outcome when a completed run has an empty or blank reply", () => {
    for (const output of ["", "   \n"]) {
      const result = mapFinalResultForTest({
        terminal: terminal("completed", {}, output),
        outputChunks: [],
        sessionKey: "k",
        strategy: "issue",
      });
      expect(result.exitCode).toBe(0);
      expect(result.outcome).toBeUndefined();
    }
  });

  it("returns no outcome through execute() on an HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })));
    const result = await execute(makeCtx());
    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("hermes_gateway_upstream_error");
    expect(result.outcome).toBeUndefined();
  });

  it("returns no outcome through execute() when the stream reports status failed", async () => {
    vi.stubGlobal(
      "fetch",
      gatewayFetch(
        () =>
          new Response(
            sseStream(["event: run.failed", `data: ${JSON.stringify({ status: "failed", error: "nope" })}`, ""].join("\n")),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBeUndefined();
  });

  it("returns no outcome through execute() when the response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/v1/runs")
          ? new Response("<html>not json</html>", { status: 200 })
          : new Response("", { status: 200 }),
      ),
    );
    const result = await execute(makeCtx());
    expect(result.outcome).toBeUndefined();
  });

  it("returns the outcome through execute() for a normal completed run", async () => {
    vi.stubGlobal("fetch", gatewayFetch(() => completedEvents("all done")));
    const result = await execute(makeCtx());
    expect(result.exitCode).toBe(0);
    expect(result.outcome?.kind).toBe("reply_delivered");
  });
});

describe("gateway prompt and credentials", () => {
  async function promptFor(ctx: AdapterExecutionContext) {
    const fetchMock = gatewayFetch(() => completedEvents("done"));
    vi.stubGlobal("fetch", fetchMock);
    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    return { init: createCall![1] as RequestInit, body: JSON.parse(String(createCall![1]?.body)) as { input: string }, calls };
  }

  it("tells the agent its reply is the outcome when the server says it will be recorded", async () => {
    const { body } = await promptFor(makeCtx({ paperclipRecordsReplyOutcome: true }));
    expect(body.input).toContain("Your reply is recorded as this task's outcome automatically.");
    expect(body.input).toContain("Don't try to change the task's status.");
    expect(body.input).not.toContain("clear final disposition");
    expect(body.input).not.toContain("X-Paperclip-Run-Id");
  });

  it("keeps today's execution contract when the setting is off or absent", async () => {
    for (const extra of [{}, { paperclipRecordsReplyOutcome: false }]) {
      const { body } = await promptFor(makeCtx(extra));
      expect(body.input).toContain("update the issue to a clear final disposition");
      expect(body.input).not.toContain("recorded as this task's outcome automatically");
    }
  });

  it("gives the gateway no Paperclip API URL or key, with the setting on or off", async () => {
    for (const extra of [{}, { paperclipRecordsReplyOutcome: true }]) {
      const { init, body, calls } = await promptFor(makeCtx(extra));
      const everything = JSON.stringify({ headers: init.headers, body, urls: calls.map(([input]) => String(input)) });
      expect(everything).not.toContain("PAPERCLIP_API_URL");
      expect(everything).not.toContain("PAPERCLIP_API_KEY");
      expect(everything).not.toContain("Paperclip API URL:");
      expect(Object.keys(init.headers as Record<string, string>).some((name) => /paperclip/i.test(name))).toBe(false);
      expect(Object.keys(body).sort()).toEqual(["input", "instructions", "session_id"]);
    }
  });
});
