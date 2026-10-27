# Memory hydrate hook and the Hindsight plugin

Status: implemented on the fork branch `memory-pre-run-hydrate`. Not in upstream.
The upstream design is `doc/plans/2026-03-17-memory-service-surface-api.md`; this is the
first slice of it (`pre_run_hydrate` only).

## What it is for

Agents keep the memory they already have (`MEMORY.md`, `CLAUDE.md`, skills, session
history). Hydrate adds the layer **between** agents: before a run starts, the host asks a
memory plugin for relevant memory and puts it in the prompt, so the agent gets it without
having to remember to ask.

It is read-only. Writing to a shared bank stays a deliberate act, done by the agent through
its own tools (for example a Hindsight connection with "Ask first"). Nothing here writes
memory.

## How it works

1. A plugin declares `memoryProvider` in its manifest, with the `memory.hydrate` capability,
   and implements `onPreRunHydrate(request)`.
2. When a run is prepared, `heartbeat.ts` calls `memoryHydrateService.hydrate(...)`
   (`server/src/services/memory-hydrate.ts`). It calls every ready plugin that declares
   `memoryProvider`, with a 3 second timeout.
3. Each reply is validated against `memoryPreRunHydrateResultSchema`
   (`packages/shared/src/memory-hydrate.ts`): at most 12 snippets, 2,000 characters each,
   a 2,000 character profile summary.
4. The merged result is stored as `context.paperclipMemory`. It is set or cleared on every
   wake, so a resumed session never keeps a stale block and a forged value cannot survive.
5. Recalled text is **not persisted**. `withoutRecalledMemory` (`server/src/services/memory-hydrate.ts`)
   strips `paperclipMemory` from the context before every write to
   `heartbeat_runs.contextSnapshot`: the direct writes in `heartbeat.ts` and the `patch` of
   `setRunStatus` / `setRunStatusFromLive`. A test fails if `heartbeat.ts` gains a raw
   `.set({ contextSnapshot: context })`. The agent still sees the text in its prompt, so the
   provider's own session transcript (for example Claude's) will contain it; Paperclip's database
   and activity log do not.
6. `renderPaperclipMemoryNote` (`packages/adapter-utils/src/server-utils.ts`) renders it as
   its own prompt section, separate from the wake prompt, so it appears on fresh and
   resumed runs.

Request fields: `companyId`, `agentId`, `issueId`, `runId`, and `query` (the issue title,
or null).

### Failure behaviour

Recall is best-effort and never blocks a run.

- A plugin that errors, times out or returns an invalid shape is logged and skipped; the
  result is marked `partial`.
- `partial` is rendered into the prompt ("Some memory could not be reached, so a missing
  memory here does not mean nothing is remembered"), so an empty block is not read as
  "nothing is remembered".
- Each provider call writes one `memory.hydrated` activity entry with `pluginKey`,
  `outcome`, `snippetCount`, `latencyMs` and `issueId`. Recalled text is never written to
  the activity log.

### What the agent is told

The block frames snippets as notes written by other work, not instructions, and says the
agent's own files, the task and the current repo state win if they disagree. Each snippet
carries its source (for example `team-shared`) and record id so a person can find and
correct it.

## Adapter coverage

Only `claude-local` renders the block today (`claude-local/src/server/execute.ts`). Other
adapters still call `selectPaperclipPromptSections` and will ignore `paperclipMemory` until
they add `renderPaperclipMemoryNote` to their prompt. `selectPaperclipPromptSections` is
unchanged on purpose, so existing callers and tests are unaffected.

## Writing a memory plugin

```ts
definePlugin({
  async onPreRunHydrate(request) {
    return { snippets: [{ text: "…", source: "team-shared", recordId: "m1" }] };
  },
});
```

Manifest: `capabilities` includes `memory.hydrate`, and `memoryProvider: { name, description }`
is set. The manifest validator rejects `memoryProvider` without the capability.

## The Hindsight plugin

`packages/plugins/plugin-hindsight-memory` (`paperclip.hindsight-memory`).

- **Banks.** The agent never names a bank. The plugin derives them from the agent's name:
  `agent-<slug>` (read unfiltered) and `team-shared` (read filtered to `for:<slug>` and the
  agent's `topic:` tags, OR, untagged excluded). Topics come from the `agentTopics` config.
- **Reads only.** `POST /v1/default/banks/{bank}/memories/recall` on both banks in
  parallel, 2.5 second timeout each. A 404 bank counts as empty. One failing bank marks the
  result `partial`; both failing throws, so the host logs the run as failed and starts it
  without memory.
- **Requires an API key.** The plugin refuses to run without one and never calls an
  unauthenticated Hindsight. The key is a secret reference, resolved on each call, never
  cached or logged. It is sent as `Authorization: Bearer <key>`; Hindsight 0.10.2 declares
  no auth scheme in its OpenAPI spec, so confirm the real header when auth is enabled.
- **Privacy.** The query sent to Hindsight is the issue title. Do not retain student
  personal data, secrets or raw document contents in any bank.

Config: `baseUrl`, `apiKey`, `sharedBank` (default `team-shared`), `agentBankPrefix`
(default `agent-`), `maxTokens` (1500), `requestTimeoutMs` (2500), `agentTopics`.

### Prerequisites on the production host

- Hindsight auth enabled (it currently answers without a key and holds no banks).
- The extraction LLM provider named, because retained memory text is sent to it.
- The fork built and deployed with this branch; the hook is not in upstream.

## Not done yet

- Other adapters rendering the block.
- A UI label for the `memory.hydrated` activity.
- `post_run_capture`, deliberately deferred: automatic capture needs redaction first and
  must write to the agent's own bank only.
- A live test against Hindsight. Tests use a fake server.
