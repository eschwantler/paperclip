export interface HindsightRecallResult {
  id: string;
  text: string;
  tags?: string[] | null;
}

export class HindsightHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface HindsightClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export function createHindsightClient(options: HindsightClientOptions) {
  async function recall(
    bankId: string,
    body: { query: string; maxTokens: number; tags?: string[] },
  ): Promise<HindsightRecallResult[]> {
    const response = await options.fetchImpl(
      `${options.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          query: body.query,
          max_tokens: body.maxTokens,
          ...(body.tags && body.tags.length > 0 ? { tags: body.tags, tags_match: "any_strict" } : {}),
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    // Never echo the response body: it can hold memory text or credentials.
    if (!response.ok) throw new HindsightHttpError(response.status, `Hindsight recall failed with HTTP ${response.status}`);
    const json = (await response.json()) as { results?: unknown };
    if (!Array.isArray(json.results)) return [];
    return json.results.flatMap((entry): HindsightRecallResult[] => {
      const item = entry as Partial<HindsightRecallResult>;
      if (typeof item?.id !== "string" || typeof item.text !== "string" || !item.text.trim()) return [];
      return [{ id: item.id, text: item.text, tags: Array.isArray(item.tags) ? item.tags : null }];
    });
  }
  return { recall };
}
