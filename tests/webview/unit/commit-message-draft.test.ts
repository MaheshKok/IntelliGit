import { describe, expect, it } from "vitest";
import { commitMessageGenerationPrefix } from "../../../src/webviews/react/shared/commitMessageDraft";

describe("commitMessageGenerationPrefix", () => {
    it("keeps the typed draft and separates generated text with one newline", () => {
        expect(commitMessageGenerationPrefix("JIRA-123")).toBe("JIRA-123\n");
    });

    it("collapses trailing whitespace so the separator is never doubled", () => {
        expect(commitMessageGenerationPrefix("JIRA-123\n\n  ")).toBe("JIRA-123\n");
        expect(commitMessageGenerationPrefix("first\nsecond   ")).toBe("first\nsecond\n");
    });

    it("preserves interior blank lines belonging to the draft", () => {
        expect(commitMessageGenerationPrefix("subject\n\nbody")).toBe("subject\n\nbody\n");
    });

    it("contributes nothing for an empty or whitespace-only draft", () => {
        expect(commitMessageGenerationPrefix("")).toBe("");
        expect(commitMessageGenerationPrefix("   \n\t\n")).toBe("");
    });
});
