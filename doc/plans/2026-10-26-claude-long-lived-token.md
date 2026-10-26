# Fixing the Claude 8-hour session timeout in Paperclip

**Branch:** `claude-long-lived-token` on `github.com/eschwantler/paperclip`. Commits: `55a4e6a76` (feature) and `19139f4fa` (route test).

## The problem
Connecting Claude through Paperclip's local sign-in stores only the OAuth access token. That token lasts about 8 hours, so the connection dies within a day and has to be reconnected.

## The fix
Paperclip now accepts a long-lived token from `claude setup-token`, pasted into the connection form. That token lasts about a year. It replaces the local sign-in for Claude connections.

What changed:
- **Schema** (`packages/shared/src/ai-connections.ts`): `localAiConnectionSchema` gets an optional `setupToken`. It is trimmed, 80-400 characters, and limited to token characters.
- **Verification** (`packages/adapters/claude-local/src/server/quota.ts`): the new `probeClaudeLongLivedToken()` runs `claude -p` once in a temporary directory with `CLAUDE_CODE_OAUTH_TOKEN` set to the pasted token. It expects the reply "ok". It can't use the usage endpoint, because these tokens are inference-only and that endpoint returns 403.
- **Route** (`server/src/routes/ai-connections.ts`): `POST .../ai-connections/local` takes a `setupToken` branch.
  - It is Anthropic-only and can't be combined with `localSessionId`.
  - It checks create access, probes the token, and saves it.
  - It skips the local-sign-in requirement.
- **Log redaction** (`server/src/middleware/redact-sensitive.ts`): `setupToken` and `setup_token` are added to the sensitive keys.
- **UI** (`AiConnectionCredentialStep.tsx`, `ui/src/api/ai-connections.ts`): a "Paste a long-lived token instead" link opens a password field for the token.
- **Tests:** schema and redaction tests (`claude-long-lived-token.test.ts`) and a route test (`claude-long-lived-token-route.test.ts`).

## How a colleague uses it
1. Get the code:
   ```sh
   git clone git@github.com:eschwantler/paperclip.git
   cd paperclip && git checkout claude-long-lived-token
   pnpm install && pnpm dev
   ```
   To keep an existing clone, fetch this remote and merge or cherry-pick `55a4e6a76` and `19139f4fa`.
2. On a machine signed in to their own Claude account, run `claude setup-token` and copy the whole token.
3. In Paperclip, go to Connect (or Reconnect) -> Claude -> **Paste a long-lived token instead**. Paste the token and click **Connect with token**.
4. Paperclip checks the token with one CLI call. If it accepts the token, the connection no longer expires daily.

## Notes
- The `claude` CLI has to be on the server's `PATH`, because the verification step runs it.
- The token grants access to that Claude account. Each person should generate their own, and nobody should paste one into chat or commit it.
- Run `pnpm test` before opening a PR.
