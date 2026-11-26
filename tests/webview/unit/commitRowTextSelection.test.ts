import { describe, expect, it } from "vitest";
import { COMMIT_ROW_CLASS_CSS } from "../../../src/webviews/react/commit-list/styles";

/**
 * Multi-row selection is a row gesture. A browser's default shift-click extends the
 * document text selection from the previous click, so three selected commits also painted
 * their messages, refs and metadata blue. The branch panel already opts its rows out of
 * text selection; commit rows are list rows with a button role and need the same treatment.
 */
describe("commit row text selection", () => {
    it("keeps row text out of the document selection", () => {
        const rule = /\.commit-row\s*\{([^}]*)\}/.exec(COMMIT_ROW_CLASS_CSS);
        expect(rule, "the .commit-row rule must remain in the injected stylesheet").not.toBeNull();
        expect(rule?.[1]).toMatch(/(?:^|;)\s*user-select:\s*none\s*(?:;|$)/);
    });
});
