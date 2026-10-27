import { eq } from "drizzle-orm";
import { plugins, type Db } from "@paperclipai/db";
import {
  memoryPreRunHydrateResultSchema,
  type MemoryPreRunHydrateRequest,
  type MemoryPreRunHydrateResult,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

/** Recall is best-effort, so it gets a short budget rather than delaying the run. */
export const MEMORY_HYDRATE_TIMEOUT_MS = 3_000;

/**
 * Ask every ready memory plugin to recall memory for a run that is about to start.
 * Failures are logged and never thrown: a memory outage must not block a run.
 * Returns null when no plugin contributed anything.
 */
export function memoryHydrateService(db: Db, workerManager?: PluginWorkerManager) {
  async function hydrate(input: MemoryPreRunHydrateRequest): Promise<MemoryPreRunHydrateResult | null> {
    if (!workerManager) return null;
    const providers = (await db.select().from(plugins).where(eq(plugins.status, "ready"))).filter(
      (plugin) =>
        plugin.manifestJson.memoryProvider &&
        plugin.manifestJson.capabilities.includes("memory.hydrate") &&
        workerManager.isRunning(plugin.id),
    );
    if (providers.length === 0) return null;

    const merged: MemoryPreRunHydrateResult = { snippets: [] };
    const summaries: string[] = [];
    for (const plugin of providers) {
      const startedAt = Date.now();
      let outcome: "ok" | "failed" = "ok";
      let snippetCount = 0;
      try {
        const raw = await workerManager.call(plugin.id, "preRunHydrate", input, MEMORY_HYDRATE_TIMEOUT_MS);
        const result = memoryPreRunHydrateResultSchema.parse(raw);
        snippetCount = result.snippets.length;
        merged.snippets.push(...result.snippets);
        if (result.profileSummary) summaries.push(result.profileSummary);
        if (result.partial) merged.partial = true;
      } catch (error) {
        outcome = "failed";
        merged.partial = true;
        logger.warn({ err: error, pluginKey: plugin.pluginKey, runId: input.runId }, "memory hydrate failed; starting run without it");
      }
      // Counts only: recalled text can hold anything an agent wrote, so it stays out of the activity log.
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.agentId,
        runId: input.runId,
        action: "memory.hydrated",
        entityType: "agent",
        entityId: input.agentId,
        details: { pluginKey: plugin.pluginKey, outcome, snippetCount, latencyMs: Date.now() - startedAt, issueId: input.issueId },
      }).catch((error) => logger.warn({ err: error, runId: input.runId }, "memory hydrate activity log failed"));
    }
    if (summaries.length > 0) merged.profileSummary = summaries.join("\n");
    return merged.snippets.length > 0 || merged.profileSummary || merged.partial ? merged : null;
  }
  return { hydrate };
}
