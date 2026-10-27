import type { HindsightMemoryConfig } from "./config.js";

/** Stable, bank-safe form of an agent name: lowercase letters, digits and dashes. */
export function agentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface ResolvedBanks {
  /** Read without a tag filter: everything this agent has learned. */
  own: string;
  /** Read filtered to this agent's topics and `for:<agent>` tags. Never written by this plugin. */
  shared: string;
  /** Tags that select the relevant part of the shared bank. */
  sharedTags: string[];
}

/**
 * The agent never names a bank. The host resolves it from the agent's identity, and
 * recall reads the agent's own bank plus a filtered slice of the shared one.
 */
export function resolveBanks(agentName: string, config: HindsightMemoryConfig): ResolvedBanks {
  const slug = agentSlug(agentName);
  if (!slug) throw new Error("Agent name does not map to a memory bank");
  const topics = config.agentTopics[slug] ?? [];
  return {
    own: `${config.agentBankPrefix}${slug}`,
    shared: config.sharedBank,
    sharedTags: [`for:${slug}`, ...topics.map((topic) => `topic:${topic}`)],
  };
}
