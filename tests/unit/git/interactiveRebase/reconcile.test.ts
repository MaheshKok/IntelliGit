import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REBASE_SESSION_MARKER } from "../../../../src/git/interactiveRebase/editorCommand";
import {
    gatherRebaseReconciliationEvidence,
    reconcileRebaseSessions,
    type RebaseReconciliationEvidence,
} from "../../../../src/git/interactiveRebase/reconcile";
import {
    type RebaseManifestListEntry,
    writeRebaseManifest,
} from "../../../../src/git/interactiveRebase/storage";
import type { RebaseSessionManifest } from "../../../../src/git/interactiveRebase/types";

const REPO_ROOT = "/fixture-repository";
const BRANCH = "refs/heads/main";
const BASE = "a".repeat(40);
const EXPECTED_HEAD = "b".repeat(40);
const REBASED_HEAD = "c".repeat(40);
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Creates valid durable state with only the fields reconciliation is allowed to use. */
function manifest(
    sessionId: string,
    lifecycle: RebaseSessionManifest["lifecycle"],
    overrides: Partial<RebaseSessionManifest> = {},
): RebaseSessionManifest {
    return {
        version: 1,
        sessionId,
        repoRoot: REPO_ROOT,
        branch: BRANCH,
        hasPushedCommit: false,
        baseHash: BASE,
        expectedHead: EXPECTED_HEAD,
        createdAt: "2026-08-02T00:00:00.000Z",
        lifecycle,
        ...overrides,
    };
}

/** Wraps valid durable state as it appears in the repository-scoped manifest list. */
function valid(manifestState: RebaseSessionManifest): RebaseManifestListEntry {
    return {
        sessionId: manifestState.sessionId,
        result: { status: "valid", manifest: manifestState },
    };
}

/** Builds a complete, hostile-testable reconciliation snapshot with safe defaults. */
function evidence(
    overrides: Partial<RebaseReconciliationEvidence> = {},
): RebaseReconciliationEvidence {
    return {
        rebaseDirectory: { status: "none" },
        manifests: [],
        head: { status: "known", oid: EXPECTED_HEAD },
        branch: { status: "attached", ref: BRANCH },
        ...overrides,
    };
}

describe("reconcileRebaseSessions", () => {
    it("recognizes an owned live rebase only after marker and all metadata fields correlate", () => {
        const live = manifest("live-session", "paused");

        expect(
            reconcileRebaseSessions(
                evidence({
                    manifests: [valid(live)],
                    rebaseDirectory: {
                        status: "merge",
                        marker: live.sessionId,
                        headName: live.branch,
                        onto: live.baseHash,
                        origHead: live.expectedHead,
                    },
                }),
            ),
        ).toEqual({
            rebaseControl: "owned",
            dispositions: [{ status: "owned", sessionId: live.sessionId }],
        });
    });

    it("treats a live manifest with mismatched rebase metadata as foreign and retained", () => {
        const live = manifest("stale-live", "running");

        expect(
            reconcileRebaseSessions(
                evidence({
                    manifests: [valid(live)],
                    rebaseDirectory: {
                        status: "merge",
                        marker: live.sessionId,
                        headName: "refs/heads/other",
                        onto: live.baseHash,
                        origHead: live.expectedHead,
                    },
                }),
            ),
        ).toEqual({
            rebaseControl: "foreign",
            dispositions: [
                {
                    status: "ambiguous",
                    sessionId: live.sessionId,
                    reason: "rebase-directory-correlation-failed",
                },
            ],
        });
    });

    it("classifies a rebase marker that matches no manifest as unowned without injection authority", () => {
        expect(
            reconcileRebaseSessions(
                evidence({
                    rebaseDirectory: {
                        status: "merge",
                        marker: "missing-session",
                        headName: BRANCH,
                        onto: BASE,
                        origHead: EXPECTED_HEAD,
                    },
                }),
            ),
        ).toEqual({ rebaseControl: "unowned", dispositions: [] });
    });

    it("discards a matching manifest when no rebase directory remains and HEAD never moved", () => {
        const abandoned = manifest("abandoned", "paused");

        expect(reconcileRebaseSessions(evidence({ manifests: [valid(abandoned)] }))).toEqual({
            rebaseControl: "none",
            dispositions: [{ status: "discard", sessionId: abandoned.sessionId }],
        });
    });

    it("retains a manifest when HEAD moved while the extension was unloaded", () => {
        const abandoned = manifest("head-moved", "paused");

        expect(
            reconcileRebaseSessions(
                evidence({
                    manifests: [valid(abandoned)],
                    head: { status: "known", oid: REBASED_HEAD },
                }),
            ),
        ).toEqual({
            rebaseControl: "none",
            dispositions: [
                { status: "ambiguous", sessionId: abandoned.sessionId, reason: "head-moved" },
            ],
        });
    });

    it("keeps a pending-push manifest ambiguous while a different live session owns the directory", () => {
        const pending = manifest("pending-push", "completed-pending-push", {
            rebasedHeadOid: REBASED_HEAD,
        });
        const live = manifest("different-live", "paused");

        expect(
            reconcileRebaseSessions(
                evidence({
                    manifests: [valid(pending), valid(live)],
                    head: { status: "known", oid: REBASED_HEAD },
                    rebaseDirectory: {
                        status: "merge",
                        marker: live.sessionId,
                        headName: live.branch,
                        onto: live.baseHash,
                        origHead: live.expectedHead,
                    },
                }),
            ),
        ).toEqual({
            rebaseControl: "owned",
            dispositions: [
                {
                    status: "ambiguous",
                    sessionId: pending.sessionId,
                    reason: "pending-push-retained",
                },
                { status: "owned", sessionId: live.sessionId },
            ],
        });
    });

    it("default-denies corrupt state, detached HEAD, and a same-tip branch switch", () => {
        const corrupt: RebaseManifestListEntry = {
            sessionId: "corrupt",
            result: { status: "ambiguous", reason: "corrupt" },
        };
        const otherBranch = manifest("same-tip-switch", "running");

        expect(
            reconcileRebaseSessions(
                evidence({
                    manifests: [corrupt, valid(otherBranch)],
                    branch: { status: "detached" },
                }),
            ),
        ).toEqual({
            rebaseControl: "none",
            dispositions: [
                { status: "ambiguous", sessionId: corrupt.sessionId, reason: "manifest-corrupt" },
                {
                    status: "ambiguous",
                    sessionId: otherBranch.sessionId,
                    reason: "branch-unavailable-or-moved",
                },
            ],
        });

        expect(
            reconcileRebaseSessions(
                evidence({
                    manifests: [valid(otherBranch)],
                    branch: { status: "attached", ref: "refs/heads/other" },
                }),
            ).dispositions,
        ).toEqual([
            {
                status: "ambiguous",
                sessionId: otherBranch.sessionId,
                reason: "branch-unavailable-or-moved",
            },
        ]);
    });

    it("keeps a readable manifest beside a corrupt sibling instead of classifying all state alike", () => {
        const validManifest = manifest("deletable", "done");
        const corrupt: RebaseManifestListEntry = {
            sessionId: "broken",
            result: { status: "ambiguous", reason: "truncated" },
        };

        expect(
            reconcileRebaseSessions(evidence({ manifests: [corrupt, valid(validManifest)] })),
        ).toEqual({
            rebaseControl: "none",
            dispositions: [
                { status: "ambiguous", sessionId: corrupt.sessionId, reason: "manifest-truncated" },
                { status: "discard", sessionId: validManifest.sessionId },
            ],
        });
    });

    it("never acts on a manifest that answers to a different name than its file", () => {
        // A disposition is carried out against the file the entry was read from. Trusting the
        // embedded identifier instead would delete or claim ownership of a different session's
        // state than the one the evidence describes, so neither authority may cross the two.
        const renamed: RebaseManifestListEntry = {
            sessionId: "file-name",
            result: { status: "valid", manifest: manifest("embedded-name", "running") },
        };

        expect(reconcileRebaseSessions(evidence({ manifests: [renamed] }))).toEqual({
            rebaseControl: "none",
            dispositions: [
                { status: "ambiguous", sessionId: "file-name", reason: "manifest-missing" },
            ],
        });

        expect(
            reconcileRebaseSessions(
                evidence({
                    manifests: [renamed],
                    rebaseDirectory: {
                        status: "merge",
                        marker: "embedded-name",
                        headName: BRANCH,
                        onto: BASE,
                        origHead: EXPECTED_HEAD,
                    },
                }),
            ).rebaseControl,
        ).toBe("unowned");
    });

    it.each([
        ["an apply-layout rebase", { status: "apply" } as const],
        [
            "a merge rebase started outside IntelliGit",
            { status: "merge", marker: "someone-else" } as const,
        ],
    ])(
        "reports %s as foreign while a live manifest is still retained",
        (_name, rebaseDirectory) => {
            // Without a live session the same directory is `unowned` — Git controls are safe because
            // nothing of ours is at stake. A retained live manifest is exactly what makes it foreign,
            // so collapsing the two would hand a running foreign rebase the safe-to-operate label.
            const live = manifest("retained-live", "paused");

            expect(
                reconcileRebaseSessions(evidence({ manifests: [valid(live)], rebaseDirectory })),
            ).toEqual({
                rebaseControl: "foreign",
                dispositions: [
                    {
                        status: "ambiguous",
                        sessionId: live.sessionId,
                        reason: "rebase-directory-correlation-failed",
                    },
                ],
            });

            expect(reconcileRebaseSessions(evidence({ rebaseDirectory })).rebaseControl).toBe(
                "unowned",
            );
        },
    );
});

describe("gatherRebaseReconciliationEvidence", () => {
    it("takes one marker-first snapshot before selecting the matching manifest", async () => {
        const storageRoot = await mkdtemp(path.join(os.tmpdir(), "intelligit-reconcile-storage-"));
        const gitDir = await mkdtemp(path.join(os.tmpdir(), "intelligit-reconcile-git-"));
        roots.push(storageRoot, gitDir);
        const live = manifest("gathered-live", "paused");
        await writeRebaseManifest(storageRoot, live);
        const rebaseDirectory = path.join(gitDir, "rebase-merge");
        await mkdir(rebaseDirectory);
        await Promise.all([
            writeFile(path.join(rebaseDirectory, REBASE_SESSION_MARKER), live.sessionId + "\n"),
            writeFile(path.join(rebaseDirectory, "head-name"), live.branch + "\n"),
            writeFile(path.join(rebaseDirectory, "onto"), live.baseHash + "\n"),
            writeFile(path.join(rebaseDirectory, "orig-head"), live.expectedHead + "\n"),
        ]);
        const runBinary = vi.fn(async (args: string[]) => ({
            stdout: Buffer.from((args[0] === "rev-parse" ? EXPECTED_HEAD : BRANCH) + "\n"),
            stderr: Buffer.alloc(0),
            exitCode: 0,
            truncated: false,
        }));

        const snapshot = await gatherRebaseReconciliationEvidence(
            { storageRoot, gitDir, executor: { runBinary } },
            REPO_ROOT,
        );

        expect(snapshot.rebaseDirectory).toEqual({
            status: "merge",
            marker: live.sessionId,
            headName: live.branch,
            onto: live.baseHash,
            origHead: live.expectedHead,
        });
        expect(reconcileRebaseSessions(snapshot)).toEqual({
            rebaseControl: "owned",
            dispositions: [{ status: "owned", sessionId: live.sessionId }],
        });
        expect(runBinary).toHaveBeenCalledTimes(2);
    });
});
