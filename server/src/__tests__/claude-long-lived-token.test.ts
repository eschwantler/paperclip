import { describe, expect, it } from "vitest";
import { localAiConnectionSchema } from "@paperclipai/shared";
import { redactSensitive } from "../middleware/redact-sensitive.js";

const base = { provider: "anthropic", method: "subscription", name: "Claude3", ownership: "shared" } as const;
const token = "sk-ant-oat01-" + "A".repeat(95);

describe("pasted Claude long-lived token", () => {
  it("accepts a well-formed token and trims it", () => {
    expect(localAiConnectionSchema.parse({ ...base, setupToken: `  ${token}\n` }).setupToken).toBe(token);
  });
  it("rejects short, spaced or empty tokens", () => {
    for (const setupToken of ["", "short", token.slice(0, 40), `${token} extra`])
      expect(localAiConnectionSchema.safeParse({ ...base, setupToken }).success).toBe(false);
  });
  it("is optional, so the local sign-in path is unchanged", () => {
    expect(localAiConnectionSchema.safeParse(base).success).toBe(true);
  });
  it("is redacted from request-body logs", () => {
    expect(JSON.stringify(redactSensitive({ ...base, setupToken: token }))).not.toContain(token);
  });
});
