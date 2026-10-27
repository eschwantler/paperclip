import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.hindsight-memory",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Hindsight Memory",
  description: "Recalls Hindsight memory into an agent run before it starts, from the agent's own bank and a filtered shared bank.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: ["memory.hydrate", "agents.read", "secrets.read-ref", "http.outbound"],
  memoryProvider: {
    name: "Hindsight",
    description: "Reads agent-<name> and a topic-filtered team-shared bank. Writes stay explicit, through the agent's own tools.",
  },
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    required: ["baseUrl", "apiKey"],
    properties: {
      baseUrl: { type: "string", format: "uri", title: "Hindsight URL", description: "For example http://100.72.171.100:8888" },
      apiKey: { type: "string", format: "secret-ref", title: "API key", description: "Required. The plugin will not call an unauthenticated Hindsight." },
      sharedBank: { type: "string", title: "Shared bank", default: DEFAULT_CONFIG.sharedBank },
      agentBankPrefix: { type: "string", title: "Agent bank prefix", default: DEFAULT_CONFIG.agentBankPrefix },
      maxTokens: { type: "integer", title: "Max tokens per bank", default: DEFAULT_CONFIG.maxTokens },
      requestTimeoutMs: { type: "integer", title: "Request timeout (ms)", default: DEFAULT_CONFIG.requestTimeoutMs },
      agentTopics: {
        type: "object",
        title: "Agent topics",
        description: "Topics per agent slug. Shared memory is recalled for these topics and for for:<agent> tags.",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
    },
  },
};

export default manifest;
