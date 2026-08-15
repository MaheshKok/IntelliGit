/**
 * Spec-derived tests for `src/mergeEditor/editorFontSize.ts`.
 *
 * This function is the ONLY thing standing between a user's `editor.fontSize` and the merge-editor
 * webview's code rendering, and its whole contract is what it REJECTS: an out-of-range or
 * wrong-typed value must come back `undefined` so the stylesheet falls through to its own variable
 * chain, rather than being forwarded as a literal `px` value the browser would honor. It is now
 * read by two panels (`MergeEditorPanel` and `ShelfConflictEditorPanel`), so its bounds are asserted
 * here directly rather than inferred from either panel's payload -- a fixture pinned at one valid
 * value (14) exercises none of the branches below.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getConfigurationValue = vi.hoisted(() => vi.fn());
const vscodeMock = vi.hoisted(() => ({
    workspace: {
        getConfiguration: vi.fn(() => ({ get: getConfigurationValue })),
    },
}));

vi.mock("vscode", () => vscodeMock);

import { readEditorFontSize } from "../../../src/mergeEditor/editorFontSize";

describe("readEditorFontSize", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vscodeMock.workspace.getConfiguration.mockReturnValue({ get: getConfigurationValue });
    });

    it("reads editor.fontSize from the editor section, not some other section", () => {
        getConfigurationValue.mockReturnValue(14);

        expect(readEditorFontSize()).toBe(14);
        expect(vscodeMock.workspace.getConfiguration).toHaveBeenCalledWith("editor");
        expect(getConfigurationValue).toHaveBeenCalledWith("fontSize");
    });

    // VS Code's own accepted range is [6, 100]; both endpoints are INCLUDED, so both are asserted
    // as accepted and their immediate neighbours as rejected. A `>` / `>=` slip is invisible to a
    // test that only checks a mid-range value.
    it.each([6, 7, 99, 100])("accepts %s -- inside VS Code's own bounds", (size) => {
        getConfigurationValue.mockReturnValue(size);
        expect(readEditorFontSize()).toBe(size);
    });

    it.each([5, 5.9, 100.1, 101, 0, -14])("rejects %s -- outside VS Code's own bounds", (size) => {
        getConfigurationValue.mockReturnValue(size);
        expect(readEditorFontSize()).toBeUndefined();
    });

    it.each([
        ["absent", undefined],
        ["null", null],
        ["a string", "14"],
        ["NaN", Number.NaN],
    ])("returns undefined when the setting is %s", (_label, value) => {
        getConfigurationValue.mockReturnValue(value);
        expect(readEditorFontSize()).toBeUndefined();
    });

    // A configuration read can throw (no workspace, a disposed extension host). Falling back to
    // undefined keeps a merge editor rendering at the CSS default instead of failing to open.
    it("returns undefined instead of propagating a configuration read failure", () => {
        vscodeMock.workspace.getConfiguration.mockImplementation(() => {
            throw new Error("configuration is unavailable");
        });

        expect(readEditorFontSize()).toBeUndefined();
    });
});
