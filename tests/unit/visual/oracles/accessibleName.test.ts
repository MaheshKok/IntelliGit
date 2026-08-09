import { describe, expect, it } from "vitest";

import {
    findAccessibleNameViolations,
    type AccessibleNameFailureKind,
} from "../../../visual/oracles/accessibleName";

describe("findAccessibleNameViolations", () => {
    it("returns no findings for equal names after whitespace and NFC normalization", () => {
        expect(
            findAccessibleNameViolations([
                {
                    id: "label",
                    computedName: "  Cafe\u0301  au\t lait ",
                    sourceText: "Café au lait",
                },
                {
                    id: "dom-text",
                    computedName: "Full visible text",
                    sourceText: "Full visible text",
                },
            ]),
        ).toEqual([]);
    });

    it("can fail: reports an empty computed name for non-empty source text", () => {
        const kind: AccessibleNameFailureKind = "empty-name";

        expect(
            findAccessibleNameViolations([
                { id: "icon-button", computedName: " \n\t ", sourceText: "Open settings" },
            ]),
        ).toEqual([{ id: "icon-button", kind }]);
    });

    it("can fail: reports a strict prefix as a truncated name", () => {
        expect(
            findAccessibleNameViolations([
                {
                    id: "branch",
                    computedName: "feature/login",
                    sourceText: "feature/login (remote)",
                },
            ]),
        ).toEqual([{ id: "branch", kind: "truncated-name" }]);
    });

    it("can fail: reports an ellipsis whose stripped form is a strict prefix", () => {
        expect(
            findAccessibleNameViolations([
                {
                    id: "commit",
                    computedName: "Fix parser...",
                    sourceText: "Fix parser regression",
                },
                { id: "issue", computedName: "Fix parser…", sourceText: "Fix parser regression" },
            ]),
        ).toEqual([
            { id: "commit", kind: "truncated-name" },
            { id: "issue", kind: "truncated-name" },
        ]);
    });

    it("can fail: reports a non-prefix accessible name mismatch", () => {
        expect(
            findAccessibleNameViolations([
                { id: "override", computedName: "Remove remote", sourceText: "Delete remote" },
            ]),
        ).toEqual([{ id: "override", kind: "name-mismatch" }]);
    });

    it("does not call an ellipsis truncated when stripping it is not a strict prefix", () => {
        expect(
            findAccessibleNameViolations([
                { id: "same", computedName: "Delete…", sourceText: "Delete" },
                { id: "different", computedName: "Delete...", sourceText: "Delete" },
            ]),
        ).toEqual([
            { id: "same", kind: "name-mismatch" },
            { id: "different", kind: "name-mismatch" },
        ]);
    });

    it("does not report two empty normalized strings", () => {
        expect(
            findAccessibleNameViolations([
                { id: "decorative", computedName: " \t", sourceText: "\n" },
            ]),
        ).toEqual([]);
    });

    it("is deterministic and does not mutate its input", () => {
        const samples = [
            { id: "one", computedName: "Open", sourceText: "Open" },
            { id: "two", computedName: "Close...", sourceText: "Close dialog" },
        ] as const;
        const before = structuredClone(samples);

        const first = findAccessibleNameViolations(samples);
        const second = findAccessibleNameViolations(samples);

        expect(first).toEqual(second);
        expect(samples).toEqual(before);
    });
});
