/**
 * Spec-derived tests for `src/views/shared/postedPayload.ts` -- the two pure functions that decide
 * whether an outgoing `setCommitDetail` webview payload is byte-identical to the last one actually
 * posted (see `CommitInfoViewProvider.decorateAndStoreDetail` and its three siblings for the
 * redundant-post defect these functions exist to guard against).
 *
 * The trap this module exists to avoid: `IconThemeService.decorateCommitDetailWithFolderIcons`
 * awaits `initIconThemeData()` BEFORE decorating, so a second post can legitimately carry
 * `iconFonts` / `folderIcon` / `folderExpandedIcon` / `folderIconsByName` that were not yet
 * initialized when the FIRST post went out. `isRedundantPost` must therefore compare the fully
 * built outgoing payload, not just the commit detail -- case 2 below ("iconFonts only") is the one
 * test in this file that a naive "did the commit detail change" guard would get wrong.
 */

import { describe, expect, it } from "vitest";

import {
    isRedundantPost,
    serializeWebviewPayload,
} from "../../../../src/views/shared/postedPayload";

/** A minimal, representative `setCommitDetail` payload shape -- mirrors what
 * `CommitInfoViewProvider`'s `postCurrentState` (and its three siblings) actually build. Kept as a
 * plain object literal, not the real `CommitInfoOutbound` type, since these are pure-function tests
 * of serialization/comparison, not of any one provider's exact message contract. */
function basePayload(): Record<string, unknown> {
    return {
        type: "setCommitDetail",
        detail: {
            hash: "b08ddf030532f359194329a212f0d9ba54bb6a02",
            shortHash: "b08ddf03",
            message: "Add conflict target",
            body: "",
            author: "IntelliGit Fixture Repo",
            email: "intelligit-fixture@example.invalid",
            date: "2000-01-01T01:00:00Z",
            parentHashes: ["70fa528600605d9b3f1fce7aa04ec799ed494ffd"],
            refs: [],
            files: [{ path: "conflict.txt", status: "A", additions: 3, deletions: 0 }],
        },
        folderIcon: undefined,
        folderExpandedIcon: undefined,
        folderIconsByName: {},
        iconFonts: [],
    };
}

describe("serializeWebviewPayload", () => {
    it("produces the same string for two structurally-identical payloads", () => {
        expect(serializeWebviewPayload(basePayload())).toBe(serializeWebviewPayload(basePayload()));
    });

    it("is sensitive to key insertion order -- documented honestly, not papered over", () => {
        // Two objects with the SAME keys and values, inserted in a different order. This
        // implementation is `JSON.stringify` underneath, which preserves insertion order and does
        // NOT canonicalize it -- so these two serialize to DIFFERENT strings even though they are
        // semantically the same object. This is an accepted limitation, not a bug: every real
        // caller (`postCurrentState` and its three siblings) builds the compared payload from the
        // SAME object-literal source on every call, so insertion order is stable in production: the
        // two posts being compared always construct their top-level payload the same way, and
        // `IconThemeService.decorateCommitDetail`'s `{ ...detail, files }` spread preserves the
        // original `detail`'s key order rather than reordering it (see that function's own
        // implementation). A key-order-agnostic comparison would need to canonicalize keys
        // recursively, which nothing in this codebase currently needs.
        const orderedOne = { a: 1, b: 2 };
        const orderedTwo = { b: 2, a: 1 };

        expect(serializeWebviewPayload(orderedOne)).not.toBe(serializeWebviewPayload(orderedTwo));
    });
});

describe("isRedundantPost", () => {
    it("case 1: two identical payloads -> redundant", () => {
        const serialized = serializeWebviewPayload(basePayload());
        expect(isRedundantPost(serialized, serialized)).toBe(true);
    });

    it(
        "case 2 (THE TRAP): payloads differing ONLY in iconFonts -> NOT redundant -- late " +
            "initIconThemeData() completion must never be suppressed",
        () => {
            const before = serializeWebviewPayload(basePayload());
            const after = serializeWebviewPayload({
                ...basePayload(),
                iconFonts: [{ id: "seti", fontCharacter: "\\E001" }],
            });

            expect(isRedundantPost(after, before)).toBe(false);
        },
    );

    it("case 3: payloads differing ONLY in folderIconsByName -> NOT redundant", () => {
        const before = serializeWebviewPayload(basePayload());
        const after = serializeWebviewPayload({
            ...basePayload(),
            folderIconsByName: { src: "folder-src-icon" },
        });

        expect(isRedundantPost(after, before)).toBe(false);
    });

    it("case 4: payloads differing ONLY in folderIcon/folderExpandedIcon -> NOT redundant", () => {
        const before = serializeWebviewPayload(basePayload());
        const after = serializeWebviewPayload({
            ...basePayload(),
            folderIcon: "folder-icon-id",
            folderExpandedIcon: "folder-expanded-icon-id",
        });

        expect(isRedundantPost(after, before)).toBe(false);
    });

    it("case 5: payloads differing only deep inside detail.files[n].path -> NOT redundant", () => {
        const before = serializeWebviewPayload(basePayload());
        const changed = basePayload();
        (changed.detail as { files: Array<{ path: string }> }).files[0].path = "renamed.txt";
        const after = serializeWebviewPayload(changed);

        expect(isRedundantPost(after, before)).toBe(false);
    });

    it(
        "case 6: lastPosted === undefined -> NOT redundant, even if byte-identical to a payload " +
            "posted to a PREVIOUS webview -- a fresh webview must always receive a full post, or " +
            "view restoration renders an empty pane",
        () => {
            const serialized = serializeWebviewPayload(basePayload());
            expect(isRedundantPost(serialized, undefined)).toBe(false);
        },
    );

    it("case 7: a real-shaped payload compared against itself twice stays redundant on the third post", () => {
        // Not a new case on its own -- reinforces case 1 with the exact shape `basePayload()`
        // mirrors (nested `detail`, arrays, an empty `folderIconsByName`) rather than the trivial
        // `{a,b}` shape `serializeWebviewPayload`'s own key-order test uses.
        const serialized = serializeWebviewPayload(basePayload());
        expect(isRedundantPost(serialized, serialized)).toBe(true);
        expect(isRedundantPost(serialized, serialized)).toBe(true);
    });
});
