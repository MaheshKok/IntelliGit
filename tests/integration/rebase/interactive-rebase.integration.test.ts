import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    abortInteractiveRebase,
    continueInteractiveRebase,
} from "../../../src/git/interactiveRebase/control";
import { REBASE_SESSION_MARKER } from "../../../src/git/interactiveRebase/editorCommand";
import { forcePushRebasedHead } from "../../../src/git/interactiveRebase/push";
import {
    gatherRebaseReconciliationEvidence,
    reconcileRebaseSessions,
} from "../../../src/git/interactiveRebase/reconcile";
import { runInteractiveRebaseSubmission } from "../../../src/git/interactiveRebase/run";
import {
    getRebaseStoragePaths,
    readRebaseManifest,
} from "../../../src/git/interactiveRebase/storage";
import type { RebaseTodoEntry } from "../../../src/git/interactiveRebase/types";
import {
    cleanTemporaryRepositories,
    createConflictingRebaseFixture,
    createPushableRebaseFixture,
    createRebaseFixture,
    createRemoteCollaborator,
    git,
    plantPersistedRebaseSession,
    readBareRemoteRef,
    readHistory,
    rewritePersistedRebaseManifest,
    type PushableRebaseFixture,
    type RebaseFixture,
} from "./rebaseTestHarness";

const helperScriptPath = path.resolve(process.cwd(), "dist/interactive-rebase-editor-helper.cjs");

beforeAll(async () => {
    try {
        await access(helperScriptPath);
    } catch {
        throw new Error(
            "Interactive-rebase integration tests require the editor helper. Run `bun run build` first.",
        );
    }
});

afterEach(cleanTemporaryRepositories);

describe("interactive rebase real Git integration", () => {
    it("drops the second-from-top commit without losing the remaining history", async () => {
        const fixture = await createRebaseFixture(helperScriptPath);
        const rebaseable = fixture.commits.slice(2);
        const dropped = rebaseable.at(-2)!;
        const entries = rebaseable.map((commit) => ({
            hash: commit.hash,
            action: commit === dropped ? ("drop" as const) : ("pick" as const),
        }));

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toMatchObject({ status: "completed" });

        const history = await readHistory(fixture.root);
        expect(history).toHaveLength(3);
        expect(history.map(({ subject }) => subject)).toEqual([
            fixture.commits[0].subject,
            fixture.commits[1].subject,
            ...rebaseable.filter((commit) => commit !== dropped).map(({ subject }) => subject),
        ]);
        expect(history.map(({ subject }) => subject)).not.toContain(dropped.subject);
        // Session state lives outside the repository, so a runner that left anything behind in the
        // working tree shows up here rather than hiding behind an ignore rule.
        expect((await git(fixture.root, ["status", "--porcelain"])).toString("utf8")).toBe("");
    });

    it("reorders commits to the submitted oldest-to-newest order", async () => {
        const fixture = await createRebaseFixture(helperScriptPath);
        const rebaseable = fixture.commits.slice(2);
        const submitted = [rebaseable[1], rebaseable[0]];
        const entries = submitted.map(({ hash }) => ({ hash, action: "pick" as const }));

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toMatchObject({ status: "completed" });

        expect((await readHistory(fixture.root)).map(({ subject }) => subject)).toEqual([
            fixture.commits[0].subject,
            fixture.commits[1].subject,
            ...submitted.map(({ subject }) => subject),
        ]);
    });

    it("aborts a stopped rebase and restores the exact pre-rebase HEAD", async () => {
        const fixture = await createRebaseFixture(helperScriptPath);
        const headBeforeRun = (await git(fixture.root, ["rev-parse", "HEAD"]))
            .toString("utf8")
            .trim();
        const rebaseable = fixture.commits.slice(2);
        // Reordered so the stop lands on rewritten history. Left in place, the pinned dates make
        // the recreated commits byte-identical, so the paused HEAD would already equal
        // `headBeforeRun` and `rebase --quit` — which clears the state without restoring anything
        // — would satisfy the restore assertion below just as well as `--abort`.
        const entries: RebaseTodoEntry[] = [
            { hash: rebaseable[1].hash, action: "pick" },
            // An empty message makes Git stop at its real amend step while the helper remains active.
            { hash: rebaseable[0].hash, action: "reword", message: "" },
        ];

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toMatchObject({ status: "paused-helper-stop" });
        // The post-abort ENOENT below proves nothing unless the rebase actually reached a stopped
        // state first — without this, a run that never started would satisfy the whole test.
        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).resolves.toBeUndefined();
        // Pins the non-vacuity the reordering above buys: the restore assertion is only a test of
        // `--abort` while the paused HEAD actually differs from the one being restored.
        expect((await git(fixture.root, ["rev-parse", "HEAD"])).toString("utf8").trim()).not.toBe(
            headBeforeRun,
        );

        await expect(abortInteractiveRebase(fixture.dependencies, fixture.root)).resolves.toEqual({
            status: "aborted",
            rebaseControl: "owned",
        });

        expect((await git(fixture.root, ["rev-parse", "HEAD"])).toString("utf8").trim()).toBe(
            headBeforeRun,
        );
        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("pauses a conflicting reorder with a real conflicted index", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);
        const entries = conflictingReorderEntries(fixture);

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toEqual({ status: "paused-conflict" });

        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).resolves.toBeUndefined();
        expect((await git(fixture.root, ["ls-files", "-u"])).toString("utf8")).not.toBe("");
        await expect(readFile(path.join(fixture.root, "shared.txt"), "utf8")).resolves.toContain(
            "<<<<<<<",
        );
    });

    it("continues a resolved conflicting reorder into the submitted history", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);
        const entries = conflictingReorderEntries(fixture);

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toEqual({ status: "paused-conflict" });
        await resolveSharedFileConflict(fixture.root);

        // `completed` is reachable only from the owned path, so the result union deliberately
        // carries no `rebaseControl` here — `toEqual` pins that absence, and the OID pins that the
        // reported head is what Git produced rather than a value captured before the continue.
        const completion = await continueInteractiveRebase(fixture.dependencies, fixture.root);
        expect(completion).toEqual({
            status: "completed",
            rebasedHeadOid: (await git(fixture.root, ["rev-parse", "HEAD"]))
                .toString("utf8")
                .trim(),
        });
        expect((await readHistory(fixture.root)).map(({ subject }) => subject)).toEqual([
            fixture.commits[0].subject,
            fixture.commits[1].subject,
            fixture.commits[3].subject,
            fixture.commits[2].subject,
            fixture.commits[4].subject,
        ]);
        expect((await git(fixture.root, ["status", "--porcelain"])).toString("utf8")).toBe("");
        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        await expect(git(fixture.root, ["show", "HEAD:shared.txt"])).resolves.toEqual(
            Buffer.from("one\ntwo\nthree\nfour\nsecond\nsix\nseven\neight\nnine\nresolved ten\n"),
        );
    });

    it("keeps a queued reword message after resolving an earlier conflict", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);
        const rebaseable = fixture.commits.slice(2);
        // `third` is picked first and conflicts immediately: its patch is computed against
        // `second`, which the reorder removed from beneath it. The reword is last in the todo, so
        // Git reaches it only after the user resolves that pause — which is the whole claim here,
        // that a message written to session storage before the run survives the interruption and
        // is consumed by a helper spawned after it.
        const entries: RebaseTodoEntry[] = [
            { hash: rebaseable[1].hash, action: "pick" },
            { hash: rebaseable[0].hash, action: "pick" },
            { hash: rebaseable[2].hash, action: "reword", message: "reworded fourth" },
        ];

        await expect(
            runInteractiveRebaseSubmission(fixture.dependencies, submission(fixture, entries)),
        ).resolves.toEqual({ status: "paused-conflict" });
        await resolveSharedFileConflict(fixture.root);

        await expect(
            continueInteractiveRebase(fixture.dependencies, fixture.root),
        ).resolves.toMatchObject({ status: "completed" });
        expect((await readHistory(fixture.root)).map(({ subject }) => subject)).toEqual([
            fixture.commits[0].subject,
            fixture.commits[1].subject,
            fixture.commits[3].subject,
            fixture.commits[2].subject,
            "reworded fourth",
        ]);
    });

    it("force-pushes a rebased head to the bare remote and clears the pending offer", async () => {
        const fixture = await createPushableRebaseFixture(helperScriptPath);
        const manifest = await completePendingPushRebase(fixture);

        await expect(forcePushRebasedHead(fixture.dependencies, manifest)).resolves.toEqual({
            status: "pushed",
            offerRetained: false,
        });
        await expect(
            readBareRemoteRef(fixture.remote.root, fixture.remote.remoteHeadRef),
        ).resolves.toBe(manifest.rebasedHeadOid);
        await expect(
            access(
                getRebaseStoragePaths(fixture.dependencies.storageRoot!, fixture.root).manifestPath(
                    manifest.sessionId,
                ),
            ),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a stale lease without moving the bare remote ref", async () => {
        const fixture = await createPushableRebaseFixture(helperScriptPath);
        const manifest = await completePendingPushRebase(fixture);
        const collaborator = await createRemoteCollaborator(fixture);
        await writeFile(path.join(collaborator, "remote-advance.txt"), "advance\n", "utf8");
        await git(collaborator, ["add", "remote-advance.txt"]);
        await git(collaborator, ["commit", "-m", "advance remote"]);
        await git(collaborator, ["push", "origin", "main"]);
        // Fetching is what makes this a test of the *pinned* lease. VS Code autofetches by default,
        // and a bare `--force-with-lease` leases against the local tracking ref — once that ref has
        // caught up, a bare lease matches the remote and happily clobbers the collaborator. Only a
        // lease pinned to the object ID the manifest recorded still refuses after the fetch.
        await git(fixture.root, ["fetch", "origin"]);
        const remoteBeforeAttempt = await readBareRemoteRef(
            fixture.remote.root,
            fixture.remote.remoteHeadRef,
        );

        await expect(forcePushRebasedHead(fixture.dependencies, manifest)).resolves.toMatchObject({
            status: "failed",
        });
        await expect(
            readBareRemoteRef(fixture.remote.root, fixture.remote.remoteHeadRef),
        ).resolves.toBe(remoteBeforeAttempt);
    });

    it("refuses a moved local head without touching the bare remote ref", async () => {
        const fixture = await createPushableRebaseFixture(helperScriptPath);
        const manifest = await completePendingPushRebase(fixture);
        // Committed on `main`, so the branch check passes and only the HEAD check can refuse.
        await git(fixture.root, ["commit", "--allow-empty", "-m", "moved local head"]);
        const remoteBeforeAttempt = await readBareRemoteRef(
            fixture.remote.root,
            fixture.remote.remoteHeadRef,
        );

        await expect(forcePushRebasedHead(fixture.dependencies, manifest)).resolves.toEqual({
            status: "head-moved",
        });
        await expect(
            readBareRemoteRef(fixture.remote.root, fixture.remote.remoteHeadRef),
        ).resolves.toBe(remoteBeforeAttempt);
    });

    it("refuses a switched branch without touching the bare remote ref", async () => {
        const fixture = await createPushableRebaseFixture(helperScriptPath);
        const manifest = await completePendingPushRebase(fixture);
        // Branched at the same commit on purpose. HEAD still equals what the manifest recorded as
        // rebased, so `head-moved` cannot fire and only the branch check can produce this refusal.
        await git(fixture.root, ["switch", "-c", "other-branch"]);
        const remoteBeforeAttempt = await readBareRemoteRef(
            fixture.remote.root,
            fixture.remote.remoteHeadRef,
        );

        await expect(forcePushRebasedHead(fixture.dependencies, manifest)).resolves.toEqual({
            status: "branch-moved",
        });
        await expect(
            readBareRemoteRef(fixture.remote.root, fixture.remote.remoteHeadRef),
        ).resolves.toBe(remoteBeforeAttempt);
    });

    it("classifies an extension-driven conflicting pause as owned from Git's rebase metadata", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);

        await expect(
            runInteractiveRebaseSubmission(
                fixture.dependencies,
                submission(fixture, conflictingReorderEntries(fixture)),
            ),
        ).resolves.toEqual({ status: "paused-conflict" });

        const evidence = await gatherRebaseReconciliationEvidence(
            fixture.reconciliationDependencies,
            fixture.root,
        );
        const metadata = await readLiveRebaseMetadata(fixture);
        const sessionId = fixture.dependencies.createSessionId!();
        expect(evidence.rebaseDirectory).toEqual({
            status: "merge",
            marker: sessionId,
            ...metadata,
        });
        expect(metadata).toEqual({
            headName: "refs/heads/main",
            onto: fixture.commits[1].hash,
            origHead: fixture.commits.at(-1)!.hash,
        });
        expect(reconcileRebaseSessions(evidence)).toEqual({
            rebaseControl: "owned",
            dispositions: [{ status: "owned", sessionId }],
        });
    });

    it("refuses ownership when the marker answers but Git's metadata disagrees", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);

        await expect(
            runInteractiveRebaseSubmission(
                fixture.dependencies,
                submission(fixture, conflictingReorderEntries(fixture)),
            ),
        ).resolves.toEqual({ status: "paused-conflict" });

        const sessionId = fixture.dependencies.createSessionId!();
        const stored = await readRebaseManifest(
            fixture.reconciliationDependencies.storageRoot,
            fixture.root,
            sessionId,
        );
        if (stored.status !== "valid") {
            throw new Error(`Expected the runner's own manifest, got "${stored.status}".`);
        }
        // The session id is untouched, so the marker still answers for this manifest and only the
        // recorded base drifts away from the `onto` Git wrote. Without a scenario in this
        // direction, the three-field comparison could be a no-op and every other scenario here
        // would still pass — the owned case only ever exercises it in the matching direction.
        await rewritePersistedRebaseManifest(fixture, {
            ...stored.manifest,
            baseHash: fixture.commits[0].hash,
        });

        const evidence = await gatherRebaseReconciliationEvidence(
            fixture.reconciliationDependencies,
            fixture.root,
        );
        expect(evidence.rebaseDirectory).toMatchObject({
            marker: sessionId,
            onto: fixture.commits[1].hash,
        });
        expect(reconcileRebaseSessions(evidence)).toEqual({
            rebaseControl: "foreign",
            dispositions: [
                { status: "ambiguous", sessionId, reason: "rebase-directory-correlation-failed" },
            ],
        });
    });

    it("retains a live manifest when an outside conflicting rebase has no IntelliGit marker", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);
        const manifest = await plantPersistedRebaseSession(fixture, {
            sessionId: "00000000-0000-4000-8000-000000000002",
            lifecycle: "paused",
            branch: "refs/heads/main",
            baseHash: fixture.commits[1].hash,
            expectedHead: fixture.commits.at(-1)!.hash,
        });

        await startOutsideConflictingRebase(fixture);

        const evidence = await gatherRebaseReconciliationEvidence(
            fixture.reconciliationDependencies,
            fixture.root,
        );
        const metadata = await readLiveRebaseMetadata(fixture);
        expect(evidence.rebaseDirectory).toEqual({ status: "merge", ...metadata });
        expect(evidence.rebaseDirectory).toMatchObject({ marker: undefined });
        await expect(
            access(path.join(fixture.gitDir, "rebase-merge", REBASE_SESSION_MARKER)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(reconcileRebaseSessions(evidence)).toEqual({
            rebaseControl: "foreign",
            dispositions: [
                {
                    status: "ambiguous",
                    sessionId: manifest.sessionId,
                    reason: "rebase-directory-correlation-failed",
                },
            ],
        });
    });

    it("refuses ownership for an identical-input outside restart when only the marker differs", async () => {
        const fixture = await createConflictingRebaseFixture(helperScriptPath);
        const manifest = await plantPersistedRebaseSession(fixture, {
            sessionId: "00000000-0000-4000-8000-000000000003",
            lifecycle: "paused",
            branch: "refs/heads/main",
            baseHash: fixture.commits[0].hash,
            expectedHead: fixture.commits.at(-1)!.hash,
        });

        await startOutsideConflictingRebase(fixture);

        const evidence = await gatherRebaseReconciliationEvidence(
            fixture.reconciliationDependencies,
            fixture.root,
        );
        const metadata = await readLiveRebaseMetadata(fixture);
        expect(metadata).toEqual({
            headName: manifest.branch,
            onto: manifest.baseHash,
            origHead: manifest.expectedHead,
        });
        expect(evidence.rebaseDirectory).toEqual({ status: "merge", ...metadata });
        expect(evidence.rebaseDirectory).toMatchObject({ marker: undefined });
        await expect(
            access(path.join(fixture.gitDir, "rebase-merge", REBASE_SESSION_MARKER)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(reconcileRebaseSessions(evidence)).toEqual({
            rebaseControl: "foreign",
            dispositions: [
                {
                    status: "ambiguous",
                    sessionId: manifest.sessionId,
                    reason: "rebase-directory-correlation-failed",
                },
            ],
        });
    });

    it("retains a same-tip manifest after switching to another branch", async () => {
        const fixture = await createRebaseFixture(helperScriptPath);
        const headBeforeRebase = fixture.commits.at(-1)!.hash;
        const rebaseable = fixture.commits.slice(2);

        await expect(
            runInteractiveRebaseSubmission(
                fixture.dependencies,
                submission(fixture, [
                    { hash: rebaseable[1].hash, action: "pick" },
                    { hash: rebaseable[0].hash, action: "pick" },
                ]),
            ),
        ).resolves.toMatchObject({ status: "completed" });
        const rebasedHead = (await git(fixture.root, ["rev-parse", "HEAD"]))
            .toString("utf8")
            .trim();
        expect(rebasedHead).not.toBe(headBeforeRebase);
        await expect(access(path.join(fixture.gitDir, "rebase-merge"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        const manifest = await plantPersistedRebaseSession(fixture, {
            sessionId: "00000000-0000-4000-8000-000000000004",
            lifecycle: "paused",
            branch: "refs/heads/main",
            baseHash: fixture.commits[1].hash,
            expectedHead: rebasedHead,
        });
        await git(fixture.root, ["switch", "-c", "same-tip-branch"]);
        expect((await git(fixture.root, ["rev-parse", "HEAD"])).toString("utf8").trim()).toBe(
            manifest.expectedHead,
        );

        const evidence = await gatherRebaseReconciliationEvidence(
            fixture.reconciliationDependencies,
            fixture.root,
        );
        expect(evidence.rebaseDirectory).toEqual({ status: "none" });
        expect(reconcileRebaseSessions(evidence)).toEqual({
            rebaseControl: "none",
            dispositions: [
                {
                    status: "ambiguous",
                    sessionId: manifest.sessionId,
                    reason: "branch-unavailable-or-moved",
                },
            ],
        });
        await expect(
            access(
                getRebaseStoragePaths(
                    fixture.reconciliationDependencies.storageRoot,
                    fixture.root,
                ).manifestPath(manifest.sessionId),
            ),
        ).resolves.toBeUndefined();
    });
});

async function startOutsideConflictingRebase(fixture: RebaseFixture): Promise<void> {
    await expect(
        git(fixture.root, [
            "rebase",
            "--merge",
            "--onto",
            fixture.commits[0].hash,
            fixture.commits[1].hash,
        ]),
    ).rejects.toMatchObject({ code: 1 });
}

async function readLiveRebaseMetadata(fixture: RebaseFixture): Promise<{
    headName: string;
    onto: string;
    origHead: string;
}> {
    const rebaseDirectory = path.join(fixture.gitDir, "rebase-merge");
    const [headName, onto, origHead] = await Promise.all(
        ["head-name", "onto", "orig-head"].map(async (name) =>
            readFile(path.join(rebaseDirectory, name), "utf8").then((value) => value.trim()),
        ),
    );
    return { headName, onto, origHead };
}

function conflictingReorderEntries(fixture: RebaseFixture): RebaseTodoEntry[] {
    const rebaseable = fixture.commits.slice(2);
    return [
        { hash: rebaseable[1].hash, action: "pick" },
        { hash: rebaseable[0].hash, action: "pick" },
        { hash: rebaseable[2].hash, action: "pick" },
    ];
}

async function resolveSharedFileConflict(repositoryRoot: string): Promise<void> {
    await writeFile(
        path.join(repositoryRoot, "shared.txt"),
        "one\ntwo\nthree\nfour\nbase\nsix\nseven\neight\nnine\nresolved ten\n",
        "utf8",
    );
    await git(repositoryRoot, ["add", "shared.txt"]);
}

/** Builds the immutable request snapshot the runner receives after dialog validation. */
function submission(fixture: RebaseFixture, entries: readonly RebaseTodoEntry[]) {
    return {
        request: {
            requestId: "rebase-integration-request",
            originProvider: {},
            repoRoot: fixture.root,
            baseHash: fixture.commits[1].hash,
            rangeHashes: fixture.commits.slice(2).map(({ hash }) => hash),
            hasPushedCommit: false,
            expectedHead: fixture.commits.at(-1)!.hash,
            expectedBranch: "refs/heads/main",
        },
        entries,
    };
}

/**
 * Runs a real reorder whose submission declares pushed history and a push target, so the runner
 * stops at its pending-push outcome and yields the manifest the force push is then handed. Building
 * the manifest here rather than by hand keeps the push scenarios testing data the runner produces.
 */
async function completePendingPushRebase(fixture: PushableRebaseFixture) {
    const rebaseable = fixture.commits.slice(2);
    const { request, entries } = submission(fixture, [
        { hash: rebaseable[1].hash, action: "pick" },
        { hash: rebaseable[0].hash, action: "pick" },
    ]);
    const completion = await runInteractiveRebaseSubmission(fixture.dependencies, {
        entries,
        request: { ...request, hasPushedCommit: true, pushTarget: fixture.remote.pushTarget },
    });
    if (completion.status !== "completed-pending-push") {
        throw new Error(
            `Expected the runner to produce a pending-push manifest, got "${completion.status}".`,
        );
    }
    return completion.manifest;
}
