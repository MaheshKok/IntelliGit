/**
 * Spec-derived tests for `tests/visual/recorder/canonicalizeCapturedMessages.ts` (deliverables 1
 * and 2 of Phase 2b, combined): deep path-placeholder substitution reused from the Phase 1 core,
 * plus declared-volatile-field substitution, applied to `readonly CapturedWebviewMessage[]`.
 *
 * The determinism suite is the REAL oracle PLAN.md step 12 asks for: not "same input twice gives
 * the same output" (trivially true, proves nothing about canonicalization), but "two DIFFERENT
 * recordings -- different absolute roots, different UUIDs, different timestamps -- of the same
 * logical scenario collapse to byte-identical committed fixture bytes." The fails-loudly suite is
 * the adversarial counterpart: an undeclared volatile field must NOT be silently neutralized, so a
 * recorder that forgets to declare a new volatile field gets a loud, real diff instead of a
 * silently-passing fixture.
 */

import { describe, expect, it } from "vitest";

import type { CapturedWebviewMessage } from "../../../../src/e2e/webviewCapture";
import type { PlaceholderRoots } from "../../../fixtures/repo/placeholderCanonicalization";
import { canonicalizeCapturedMessages } from "../../../visual/recorder/canonicalizeCapturedMessages";
import { buildWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import { serializeWebviewFixture } from "../../../visual/recorder/webviewFixtureFile";
import type { VolatileFieldDeclaration } from "../../../visual/recorder/volatileFieldDeclarations";

const DECLARED_VOLATILE_FIELDS: readonly VolatileFieldDeclaration[] = [
    { path: ["shelfId"], placeholder: "<UUID>" },
    { path: ["updatedAt"], placeholder: "<TIMESTAMP>" },
];

describe("canonicalizeCapturedMessages -- determinism across two different recordings", () => {
    it("produces byte-identical serialized fixture bytes for two recordings that differ only in volatile values", () => {
        const roots1: PlaceholderRoots = {
            root: "/tmp/run1/workspace",
            originRoot: "/tmp/run1/origin.git",
            profileDir: "/tmp/run1/profile",
        };
        const roots2: PlaceholderRoots = {
            root: "/tmp/run2-elsewhere/workspace",
            originRoot: "/tmp/run2-elsewhere/origin.git",
            profileDir: "/tmp/run2-elsewhere/profile",
        };

        const recording1: readonly CapturedWebviewMessage[] = [
            {
                contextId: "commit-panel",
                message: {
                    type: "state",
                    shelfId: "11111111-1111-1111-1111-111111111111",
                    updatedAt: "2026-08-08T10:00:00.000Z",
                    repoRoot: roots1.root,
                    originUrl: `file://${roots1.originRoot}`,
                },
            },
        ];
        const recording2: readonly CapturedWebviewMessage[] = [
            {
                contextId: "commit-panel",
                message: {
                    type: "state",
                    shelfId: "99999999-9999-9999-9999-999999999999",
                    updatedAt: "2026-08-09T23:47:11.500Z",
                    repoRoot: roots2.root,
                    originUrl: `file://${roots2.originRoot}`,
                },
            },
        ];

        const canonical1 = canonicalizeCapturedMessages(
            recording1,
            roots1,
            DECLARED_VOLATILE_FIELDS,
        );
        const canonical2 = canonicalizeCapturedMessages(
            recording2,
            roots2,
            DECLARED_VOLATILE_FIELDS,
        );

        const bytes1 = serializeWebviewFixture(
            buildWebviewFixture("commit-panel", "clean", canonical1),
        );
        const bytes2 = serializeWebviewFixture(
            buildWebviewFixture("commit-panel", "clean", canonical2),
        );

        expect(bytes1).toBe(bytes2);
        // Prove it is actually the placeholder doing the work, not an accidental coincidence.
        expect(bytes1).toContain("<ROOT>");
        expect(bytes1).toContain("<ORIGIN>");
        expect(bytes1).toContain("<UUID>");
        expect(bytes1).toContain("<TIMESTAMP>");
        expect(bytes1).not.toContain("/tmp/run1");
        expect(bytes1).not.toContain("11111111-1111-1111-1111-111111111111");
    });
});

describe("canonicalizeCapturedMessages -- undeclared volatile fields fail loudly", () => {
    it("leaves an undeclared volatile field un-neutralized, so two recordings stay observably different", () => {
        const roots1: PlaceholderRoots = {
            root: "/tmp/loud1/workspace",
            originRoot: "/tmp/loud1/origin.git",
            profileDir: "/tmp/loud1/profile",
        };
        const roots2: PlaceholderRoots = {
            root: "/tmp/loud2/workspace",
            originRoot: "/tmp/loud2/origin.git",
            profileDir: "/tmp/loud2/profile",
        };

        // `sessionNonce` is deliberately NOT in DECLARED_VOLATILE_FIELDS -- it stands in for a
        // volatile field the recorder forgot to declare.
        const recording1: readonly CapturedWebviewMessage[] = [
            {
                contextId: "commit-panel",
                message: { sessionNonce: "nonce-aaaa", repoRoot: roots1.root },
            },
        ];
        const recording2: readonly CapturedWebviewMessage[] = [
            {
                contextId: "commit-panel",
                message: { sessionNonce: "nonce-zzzz", repoRoot: roots2.root },
            },
        ];

        const canonical1 = canonicalizeCapturedMessages(
            recording1,
            roots1,
            DECLARED_VOLATILE_FIELDS,
        );
        const canonical2 = canonicalizeCapturedMessages(
            recording2,
            roots2,
            DECLARED_VOLATILE_FIELDS,
        );

        const bytes1 = serializeWebviewFixture(
            buildWebviewFixture("commit-panel", "clean", canonical1),
        );
        const bytes2 = serializeWebviewFixture(
            buildWebviewFixture("commit-panel", "clean", canonical2),
        );

        // The un-declared field survives canonicalization, so the two outputs genuinely differ --
        // this is the loud failure the declared-list design exists to produce, in place of a
        // heuristic that would have silently masked it.
        expect(bytes1).not.toBe(bytes2);
        expect(bytes1).toContain("nonce-aaaa");
        expect(bytes2).toContain("nonce-zzzz");
        // Both still get path canonicalization -- only the undeclared volatile field is exempt.
        expect(bytes1).toContain("<ROOT>");
        expect(bytes1).not.toContain("/tmp/loud1");
    });
});
