/**
 * Spec-derived tests for `tests/visual/recorder/volatileFieldDeclarations.ts` (deliverable 2 of
 * Phase 2b: "canonicalize these too, driven by an EXPLICIT declared list of what is volatile --
 * not by a heuristic that guesses which strings look like dates"). This suite proves the
 * declared-list mechanism itself, isolated from path canonicalization and from the recorder's
 * full pipeline: a declared path is rewritten regardless of its value's shape, an undeclared path
 * is left completely alone (the heuristic-free contract), and a wildcard path segment reaches
 * every element of an array without the caller having to know how many elements it has.
 */

import { describe, expect, it } from "vitest";

import {
    applyVolatileFieldDeclarations,
    type VolatileFieldDeclaration,
} from "../../../visual/recorder/volatileFieldDeclarations";

describe("applyVolatileFieldDeclarations -- declared paths only", () => {
    it("rewrites a declared top-level field to its placeholder", () => {
        const declarations: readonly VolatileFieldDeclaration[] = [
            { path: ["updatedAt"], placeholder: "<TIMESTAMP>" },
        ];
        const value = { updatedAt: "2026-08-08T10:00:00.000Z", label: "unchanged" };
        const result = applyVolatileFieldDeclarations(value, declarations) as typeof value;
        expect(result.updatedAt).toBe("<TIMESTAMP>");
        expect(result.label).toBe("unchanged");
    });

    it("rewrites a declared nested field, following the exact path", () => {
        const declarations: readonly VolatileFieldDeclaration[] = [
            { path: ["session", "id"], placeholder: "<UUID>" },
        ];
        const value = { session: { id: "11111111-1111-1111-1111-111111111111", kind: "shelf" } };
        const result = applyVolatileFieldDeclarations(value, declarations) as typeof value;
        expect(result.session.id).toBe("<UUID>");
        expect(result.session.kind).toBe("shelf");
    });

    it("leaves an UNDECLARED field completely untouched, proving there is no heuristic underneath", () => {
        const declarations: readonly VolatileFieldDeclaration[] = [
            { path: ["updatedAt"], placeholder: "<TIMESTAMP>" },
        ];
        // `commitMessage` legitimately contains a date-shaped substring; a heuristic would rewrite
        // it, which is precisely the failure mode a declared list exists to avoid.
        const value = {
            updatedAt: "2026-08-08T10:00:00.000Z",
            commitMessage: "release: cut 2026-08-08 nightly build",
        };
        const result = applyVolatileFieldDeclarations(value, declarations) as typeof value;
        expect(result.commitMessage).toBe("release: cut 2026-08-08 nightly build");
    });

    it("no-ops silently when a declared path does not exist in the value, rather than throwing", () => {
        const declarations: readonly VolatileFieldDeclaration[] = [
            { path: ["missing", "field"], placeholder: "<X>" },
        ];
        const value = { present: true };
        expect(() => applyVolatileFieldDeclarations(value, declarations)).not.toThrow();
        expect(applyVolatileFieldDeclarations(value, declarations)).toEqual({ present: true });
    });

    it("applies a wildcard path segment to every element of an array", () => {
        const declarations: readonly VolatileFieldDeclaration[] = [
            { path: ["items", "*", "id"], placeholder: "<UUID>" },
        ];
        const value = {
            items: [
                { id: "aaaa", label: "one" },
                { id: "bbbb", label: "two" },
            ],
        };
        const result = applyVolatileFieldDeclarations(value, declarations) as typeof value;
        expect(result.items.map((item) => item.id)).toEqual(["<UUID>", "<UUID>"]);
        expect(result.items.map((item) => item.label)).toEqual(["one", "two"]);
    });

    it("does not mutate the input value", () => {
        const declarations: readonly VolatileFieldDeclaration[] = [
            { path: ["updatedAt"], placeholder: "<TIMESTAMP>" },
        ];
        const value = { updatedAt: "original" };
        applyVolatileFieldDeclarations(value, declarations);
        expect(value.updatedAt).toBe("original");
    });
});
