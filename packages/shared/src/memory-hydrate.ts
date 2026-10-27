import { z } from "zod";

/** Upper bounds that keep a recalled-memory block from crowding out the task itself. */
export const MEMORY_HYDRATE_MAX_SNIPPETS = 12;
export const MEMORY_HYDRATE_MAX_SNIPPET_CHARS = 2_000;
export const MEMORY_HYDRATE_MAX_PROFILE_CHARS = 2_000;

/** What a memory plugin is told about the run that is about to start. */
export interface MemoryPreRunHydrateRequest {
  companyId: string;
  agentId: string;
  issueId: string | null;
  runId: string;
  /** Free-text hint for retrieval, such as the issue title. Never required. */
  query: string | null;
}

export interface MemoryHydrateSnippet {
  text: string;
  /** Where the snippet came from, for the agent to weigh, such as "team-shared" or "agent-n8n". */
  source?: string;
  /** Plugin-chosen id the operator can use to find and correct the memory. */
  recordId?: string;
}

export interface MemoryPreRunHydrateResult {
  snippets: MemoryHydrateSnippet[];
  profileSummary?: string;
  /** True when the plugin could not reach every bank, so an empty result is not proof of no memory. */
  partial?: boolean;
}

export const memoryPreRunHydrateResultSchema = z.object({
  snippets: z.array(z.object({
    text: z.string().trim().min(1).max(MEMORY_HYDRATE_MAX_SNIPPET_CHARS),
    source: z.string().trim().min(1).max(100).optional(),
    recordId: z.string().trim().min(1).max(200).optional(),
  }).strict()).max(MEMORY_HYDRATE_MAX_SNIPPETS),
  profileSummary: z.string().trim().max(MEMORY_HYDRATE_MAX_PROFILE_CHARS).optional(),
  partial: z.boolean().optional(),
}).strict();
