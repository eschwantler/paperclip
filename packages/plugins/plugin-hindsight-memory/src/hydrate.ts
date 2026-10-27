import type { MemoryHydrateSnippet, MemoryPreRunHydrateRequest, MemoryPreRunHydrateResult } from "@paperclipai/plugin-sdk";
import { resolveBanks } from "./banks.js";
import type { HindsightMemoryConfig } from "./config.js";
import { createHindsightClient, HindsightHttpError } from "./hindsight.js";

const MAX_SNIPPETS = 12;
const MAX_SNIPPET_CHARS = 2_000;

/**
 * Recall for a run that is about to start: the agent's own bank unfiltered, plus the
 * shared bank filtered to this agent's topics. Reads only; nothing is written to Hindsight.
 */
export async function hydrate(input: {
  request: MemoryPreRunHydrateRequest;
  agentName: string;
  config: HindsightMemoryConfig;
  fetchImpl: typeof fetch;
}): Promise<MemoryPreRunHydrateResult> {
  const { request, config } = input;
  const query = request.query?.trim();
  if (!query) return { snippets: [] };

  const banks = resolveBanks(input.agentName, config);
  const client = createHindsightClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl: input.fetchImpl,
  });
  const reads = [
    { bank: banks.own, tags: undefined as string[] | undefined },
    { bank: banks.shared, tags: banks.sharedTags },
  ];
  const settled = await Promise.allSettled(
    reads.map((read) => client.recall(read.bank, { query, maxTokens: config.maxTokens, tags: read.tags })),
  );

  const snippets: MemoryHydrateSnippet[] = [];
  const seen = new Set<string>();
  let failed = 0;
  settled.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      // A bank that does not exist yet has no memory; any other error means recall is incomplete.
      if (!(outcome.reason instanceof HindsightHttpError && outcome.reason.status === 404)) failed += 1;
      return;
    }
    for (const result of outcome.value) {
      const key = `${reads[index]!.bank}:${result.id}`;
      const text = result.text.trim().slice(0, MAX_SNIPPET_CHARS);
      if (seen.has(key) || seen.has(`text:${text}`)) continue;
      seen.add(key);
      seen.add(`text:${text}`);
      snippets.push({ text, source: reads[index]!.bank, recordId: result.id });
    }
  });
  // Every read failing is an outage, not an empty memory: let the host log it as failed.
  if (failed === reads.length) throw new Error("Hindsight recall failed for every bank");
  return { snippets: snippets.slice(0, MAX_SNIPPETS), ...(failed > 0 ? { partial: true } : {}) };
}
