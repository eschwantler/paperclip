export interface HindsightMemoryConfig {
  baseUrl: string;
  /** Secret reference to the Hindsight API key. The plugin refuses to run without it. */
  apiKey: string;
  sharedBank: string;
  agentBankPrefix: string;
  maxTokens: number;
  requestTimeoutMs: number;
  /** Per-agent topics, keyed by agent slug. Shared memory is recalled for these topics and for `for:<agent>` tags. */
  agentTopics: Record<string, string[]>;
}

export const DEFAULT_CONFIG = {
  sharedBank: "team-shared",
  agentBankPrefix: "agent-",
  maxTokens: 1500,
  requestTimeoutMs: 2500,
} as const;

const asString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function parseConfig(raw: Record<string, unknown>): HindsightMemoryConfig {
  const baseUrl = asString(raw.baseUrl).replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Hindsight base URL is not configured");
  const apiKey = asString(raw.apiKey);
  if (!apiKey) throw new Error("Hindsight API key is not configured; refusing to use an unauthenticated memory server");
  const topics: Record<string, string[]> = {};
  if (raw.agentTopics && typeof raw.agentTopics === "object") {
    for (const [agent, value] of Object.entries(raw.agentTopics as Record<string, unknown>)) {
      if (Array.isArray(value)) topics[agent] = value.map(asString).filter(Boolean);
    }
  }
  const maxTokens = Number(raw.maxTokens);
  const timeout = Number(raw.requestTimeoutMs);
  return {
    baseUrl,
    apiKey,
    sharedBank: asString(raw.sharedBank) || DEFAULT_CONFIG.sharedBank,
    agentBankPrefix: asString(raw.agentBankPrefix) || DEFAULT_CONFIG.agentBankPrefix,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_CONFIG.maxTokens,
    requestTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_CONFIG.requestTimeoutMs,
    agentTopics: topics,
  };
}
