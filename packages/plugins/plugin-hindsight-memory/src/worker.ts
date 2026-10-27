import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { parseConfig } from "./config.js";
import { hydrate } from "./hydrate.js";

let context: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    context = ctx;
    ctx.logger.info("hindsight-memory plugin setup complete");
  },

  async onPreRunHydrate(request) {
    const ctx = context;
    if (!ctx) throw new Error("hindsight-memory plugin is not ready");
    const raw = await ctx.config.get(request.companyId);
    // The key is a secret reference; resolve it per call and never cache or log it.
    const apiKey = typeof raw.apiKey === "string" && raw.apiKey.trim() ? await ctx.secrets.resolve(raw.apiKey.trim()) : "";
    const config = parseConfig({ ...raw, apiKey });
    const agent = await ctx.agents.get(request.agentId, request.companyId);
    if (!agent) throw new Error("Agent not found for memory recall");
    return hydrate({ request, agentName: agent.name, config, fetchImpl: (url, init) => ctx.http.fetch(String(url), init) });
  },

  async onHealth() {
    return { status: "ok", message: "Hindsight memory plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
