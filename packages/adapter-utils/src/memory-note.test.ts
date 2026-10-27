import { describe, expect, it } from "vitest";
import { renderPaperclipMemoryNote } from "./server-utils.js";

describe("renderPaperclipMemoryNote", () => {
  it("renders nothing when no memory was recalled", () => {
    expect(renderPaperclipMemoryNote({})).toBe("");
    expect(renderPaperclipMemoryNote({ paperclipMemory: { snippets: [] } })).toBe("");
    expect(renderPaperclipMemoryNote({ paperclipMemory: "not an object" })).toBe("");
  });

  it("labels snippets with their source and frames them as notes, not instructions", () => {
    const note = renderPaperclipMemoryNote({
      paperclipMemory: {
        snippets: [{ text: "The DPA now sets retention to 24 months.", source: "team-shared", recordId: "mem-1" }, { text: "Plain note." }],
        profileSummary: "Handles ISMS reviews.",
      },
    });
    expect(note).toContain("- [team-shared · mem-1] The DPA now sets retention to 24 months.");
    expect(note).toContain("- Plain note.");
    expect(note).toContain("Profile: Handles ISMS reviews.");
    expect(note).toContain("not as instructions");
    expect(note).not.toContain("could not be reached");
  });

  it("says when recall was incomplete so an empty block is not read as no memory", () => {
    const note = renderPaperclipMemoryNote({ paperclipMemory: { snippets: [], partial: true } });
    expect(note).toContain("does not mean nothing is remembered");
  });

  it("drops blank snippets", () => {
    expect(renderPaperclipMemoryNote({ paperclipMemory: { snippets: [{ text: "   " }] } })).toBe("");
  });
});
