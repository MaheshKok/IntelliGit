import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { GitExecutor } from "../../../src/git/executor";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { restartNativeRecoveryAfterProcessExit } from "../../helpers/targetNativeCrash";
import {
    abortTargetNativeOperation,
    captureTargetNativeEvidence,
} from "../../../src/git/targetOperationRecovery";

// Two cases swap index.lock as a second Git process would: right after recovery opens or reads
// it, or once recovery closes its read handle.
const lockRead = vi.hoisted(() => ({
    swap: undefined as ((file: string) => Promise<void>) | undefined,
    when: "read" as "read" | "close",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    const after = async (file: unknown, when: "read" | "close") => {
        const swap = lockRead.swap;
        if (!swap || lockRead.when !== when) return;
        if (typeof file !== "string" || !file.endsWith("index.lock")) return;
        lockRead.swap = undefined;
        await swap(file);
    };
    const open: typeof actual.open = async (file, flags, mode) => {
        const handle = await actual.open(file, flags, mode);
        const close = handle.close.bind(handle);
        handle.close = async () => {
            await close();
            await after(file, "close");
        };
        await after(file, "read");
        return handle;
    };
    const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
        const bytes = await actual.readFile(...args);
        await after(args[0], "read");
        return bytes;
    }) as typeof actual.readFile;
    return { ...actual, open, readFile };
});

const roots: string[] = [];
afterEach(async () => {
    lockRead.swap = undefined;
    lockRead.when = "read";
    await removeScratchDirectories(...roots);
});

const cases: {
    kind: "cherry-pick" | "revert";
    scenario: string;
    stop?: string;
    crashOccurrence?: number;
    busy?: boolean;
    candidate?: "redirected" | "replaced";
    lock?: "partial" | "replaced";
}[] = [
    { kind: "cherry-pick", scenario: "normal" },
    { kind: "revert", scenario: "normal" },
    { kind: "revert", scenario: "nativeAtQuit" },
    { kind: "cherry-pick", scenario: "prunedBlob" },
    {
        kind: "cherry-pick",
        scenario: "dead owner initial candidate",
        stop: "checkpoint:abortIndexPrepared",
        crashOccurrence: 1,
    },
    {
        kind: "cherry-pick",
        scenario: "dead owner rebuilt candidate",
        stop: "afterCandidateRebuild",
        crashOccurrence: 1,
    },
    {
        kind: "cherry-pick",
        scenario: "dead owner final candidate",
        stop: "checkpoint:abortIndexPrepared",
        crashOccurrence: 2,
    },
    {
        kind: "cherry-pick",
        scenario: "dead owner written lock",
        stop: "checkpoint:abortIndexPrepared",
        crashOccurrence: 3,
    },
    {
        kind: "cherry-pick",
        scenario: "dead owner filled lock before its checkpoint",
        stop: "evidence:abortIndexPrepared",
        crashOccurrence: 3,
    },
    ...(["partial", "replaced"] as const).map((lock) => ({
        kind: "cherry-pick" as const,
        scenario: `dead owner ${lock} filled lock stays busy`,
        stop: "evidence:abortIndexPrepared",
        crashOccurrence: 3,
        busy: true,
        lock,
    })),
    {
        kind: "cherry-pick",
        scenario: "dead owner filled lock replaced while read stays busy",
        stop: "evidence:abortIndexPrepared",
        crashOccurrence: 3,
        busy: true,
    },
    {
        kind: "cherry-pick",
        scenario: "dead owner filled lock replaced as its read closes stays busy",
        stop: "evidence:abortIndexPrepared",
        crashOccurrence: 3,
        busy: true,
    },
    {
        kind: "cherry-pick",
        scenario: "dead owner published index",
        stop: "afterIndexPublish",
        crashOccurrence: 1,
    },
    {
        kind: "cherry-pick",
        scenario: "unacknowledged lock stays busy",
        stop: "evidence:abortIndexPrepared",
        crashOccurrence: 1,
        busy: true,
    },
    {
        kind: "cherry-pick",
        scenario: "redirected candidate stays busy",
        stop: "checkpoint:abortIndexPrepared",
        crashOccurrence: 1,
        busy: true,
        candidate: "redirected",
    },
    {
        kind: "cherry-pick",
        scenario: "replaced published candidate stays pending",
        stop: "afterIndexPublish",
        crashOccurrence: 1,
        busy: true,
        candidate: "replaced",
    },
    { kind: "cherry-pick", scenario: "partialInstall", stop: "beforeInstall:affected" },
    ...[
        "markerless",
        "unrelatedAtLock",
        "indexAtLock",
        "nativeAtPublication",
        "replacedLock",
        "foreignInstall",
        "affectedAtPublication",
        "affectedBeforeAbort",
        "indexBeforeAbort",
        "foreignLock",
        "nativeBeforeAbort",
        "headBeforeAbort",
        "recoveryParent",
        "recoveryCollision",
        "corruptObject",
        "missingObject",
        "affectedAtFinish",
    ].map((scenario) => ({ kind: "cherry-pick" as const, scenario })),
    ...[
        "evidence:abortPrepared",
        "checkpoint:abortPrepared",
        "beforeMove:affected",
        "afterMove:affected",
        "evidence:abortPath",
        "checkpoint:abortPath",
        "beforeInstall:affected",
        "afterInstall:affected",
        "checkpoint:abortPathsRestored",
        "evidence:abortIndexPrepared",
        "checkpoint:abortIndexPrepared",
        "beforeIndexPublish",
        "afterIndexPublish",
        "checkpoint:abortIndexRestored",
        "beforeQuit",
        "afterQuit",
        "evidence:abortNativeCleared",
        "checkpoint:abortNativeCleared",
        "beforeFinish",
        "afterFinish",
    ].map((stop) => ({
        kind: stop.includes("Quit") ? ("revert" as const) : ("cherry-pick" as const),
        scenario: `restart ${stop}`,
        stop,
    })),
];

it.each(cases)(
    "aborts $kind $scenario preserving affected stages, unrelated layers and HEAD",
    async ({ kind, scenario, stop, crashOccurrence, busy, candidate, lock }) => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "target-native-")));
        roots.push(root);
        const git = new GitExecutor(root);
        await git.run(["init", "-q"]);
        await git.run(["config", "user.name", "Fixture"]);
        await git.run(["config", "user.email", "fixture@example.invalid"]);
        await writeFile(path.join(root, "affected"), "base\n");
        await writeFile(path.join(root, "unrelated"), "original\n");
        await git.run(["add", "."]);
        await git.run(["commit", "-qm", "base"]);
        const base = (await git.run(["rev-parse", "HEAD"])).trim();
        await writeFile(path.join(root, "affected"), "incoming\n");
        await git.run(["commit", "-qam", "incoming"]);
        const commit = (await git.run(["rev-parse", "HEAD"])).trim();
        if (kind === "cherry-pick") await git.run(["checkout", "-q", base]);
        await writeFile(path.join(root, "affected"), "current\n");
        await git.run(["commit", "-qam", "current"]);
        await writeFile(path.join(root, "unrelated"), "staged\n");
        await git.run(["add", "unrelated"]);
        await writeFile(path.join(root, "unrelated"), "working\n");
        const gitDir = path.join(root, ".git");
        const persistence = await ChangelistPersistence.open(root, gitDir);
        let store = new ChangelistStore();
        await store.connect(root, gitDir);
        let lease = await store.acquireTargetOperationLease(root);
        try {
            const id = randomUUID();
            const observed = await captureTargetNativeEvidence(git, persistence, id, ["affected"]);
            const before = {
                ...observed,
                entries: [
                    { changeId: "native:affected", path: "affected", outcome: "pending" as const },
                ],
            };
            const evidenceHash = await persistence.storeTargetOperationEvidence(before);
            const prepared = await store.prepareTargetOperation(lease, {
                id,
                kind: kind === "cherry-pick" ? "cherryPick" : "revert",
                commit,
                headBefore: before.head,
                evidenceHash,
                target: { kind: "existing", id: "default", revision: store.get(root).revision },
            });
            const result = await git.runBinary([kind, "--no-commit", commit], {
                expectedExitCodes: [0, 1],
            });
            expect(result.exitCode).toBe(1);
            if (scenario === "markerless") await git.run([kind, "--quit"]);
            const after = {
                ...(await captureTargetNativeEvidence(git, persistence, id, ["affected"])),
                checkpoint: "after" as const,
                previousEvidenceHash: evidenceHash,
                entries: [
                    {
                        changeId: "native:affected",
                        path: "affected",
                        outcome: "conflicted" as const,
                    },
                ],
            };
            expect(after.index.map((entry) => entry.stage)).toEqual([1, 2, 3]);
            const state = await store.checkpointTargetOperation(lease, {
                id,
                revision: prepared.state.revision,
                expectedPhase: "prepared",
                phase: "conflicted",
                evidenceHash: await persistence.storeTargetOperationEvidence(after),
            });
            const expected = {
                id,
                revision: state.revision,
                expectedPhase: "conflicted" as const,
            };
            if (scenario === "prunedBlob") {
                const oid = before.index[0].oid;
                await unlink(path.join(gitDir, "objects", oid.slice(0, 2), oid.slice(2)));
            }
            if (scenario === "affectedBeforeAbort")
                await writeFile(path.join(root, "affected"), "external\n");
            if (scenario === "indexBeforeAbort") await git.run(["add", "affected"]);
            if (scenario === "foreignLock")
                await writeFile(path.join(gitDir, "index.lock"), "foreign lock");
            if (scenario === "nativeBeforeAbort")
                await writeFile(path.join(gitDir, "MERGE_HEAD"), `${commit}\n`);
            if (scenario === "headBeforeAbort") await git.run(["update-ref", "HEAD", base]);
            if (scenario === "recoveryParent")
                await symlink(gitDir, path.join(root, ".intelligit-recovery"));
            if (scenario === "recoveryCollision") {
                await mkdir(path.join(root, ".intelligit-recovery", id), { recursive: true });
                await writeFile(
                    path.join(root, ".intelligit-recovery", id, "0"),
                    "foreign recovery bytes\n",
                );
            }
            if (scenario === "corruptObject" || scenario === "missingObject") {
                const saved = before.paths[0].state;
                if (saved.kind !== "regular") throw new Error("Fixture must save a regular file.");
                const filename = path.join(
                    persistence.evidenceDirectory,
                    `${saved.content.hash}.bin`,
                );
                if (scenario === "corruptObject") await writeFile(filename, "corrupt\n");
                else await unlink(filename);
            }
            let stopped = false;
            const abort = () =>
                abortTargetNativeOperation(
                    git,
                    persistence,
                    store,
                    lease,
                    expected,
                    async (point) => {
                        if (scenario === "unrelatedAtLock" && point === "beforeIndexLock") {
                            await writeFile(path.join(root, "unrelated"), "new staged\n");
                            await git.run(["add", "unrelated"]);
                            await writeFile(path.join(root, "unrelated"), "new working\n");
                        }
                        if (scenario === "indexAtLock" && point === "beforeIndexLock")
                            await git.run(["add", "affected"]);
                        if (
                            scenario === "nativeAtPublication" &&
                            point === "beforeIndexPublish" &&
                            !stopped
                        ) {
                            stopped = true;
                            await writeFile(path.join(gitDir, "MERGE_HEAD"), `${commit}\n`);
                        }
                        if (scenario === "replacedLock" && point === "beforeIndexPublish") {
                            await unlink(path.join(gitDir, "index.lock"));
                            await writeFile(path.join(gitDir, "index.lock"), "foreign lock");
                        }
                        if (scenario.endsWith("Install") && point === "beforeInstall:affected")
                            await writeFile(
                                path.join(root, ".intelligit-recovery", id, "0.install"),
                                scenario === "partialInstall" ? "cur" : "foreign\n",
                            );
                        if (scenario === "affectedAtPublication" && point === "beforeIndexPublish")
                            await writeFile(path.join(root, "affected"), "external\n");
                        if (scenario === "nativeAtQuit" && point === "beforeQuit")
                            await writeFile(path.join(gitDir, "MERGE_HEAD"), `${commit}\n`);
                        if (scenario === "affectedAtFinish" && point === "beforeFinish")
                            await writeFile(path.join(root, "affected"), "external\n");
                        if (point === stop && !stopped) {
                            stopped = true;
                            throw new Error(`interrupted:${point}`);
                        }
                    },
                );
            if (
                [
                    "affectedBeforeAbort",
                    "indexBeforeAbort",
                    "indexAtLock",
                    "nativeAtPublication",
                    "replacedLock",
                    "foreignInstall",
                    "foreignLock",
                    "affectedAtPublication",
                    "nativeBeforeAbort",
                    "headBeforeAbort",
                    "recoveryParent",
                    "recoveryCollision",
                    "corruptObject",
                    "missingObject",
                    "nativeAtQuit",
                    "affectedAtFinish",
                ].includes(scenario)
            ) {
                await expect(
                    abort(),
                    "changed affected state or a foreign lock must stop recovery",
                ).rejects.toThrow();
                expect(
                    store.get(root).pendingTargetOperation,
                    "failed recovery must retain the durable pending fence",
                ).toBeDefined();
                if (scenario.startsWith("affected"))
                    await expect(
                        readFile(path.join(root, "affected"), "utf8"),
                        "changed affected bytes must remain at the original path",
                    ).resolves.toBe("external\n");
                if (scenario === "affectedAtPublication")
                    expect(
                        await git.run(["ls-files", "-u"]),
                        "a post-restore edit must stop index publication",
                    ).not.toBe("");
                if (scenario === "foreignLock" || scenario === "replacedLock")
                    await expect(
                        readFile(path.join(gitDir, "index.lock"), "utf8"),
                        "a lock this abort does not own must never be deleted",
                    ).resolves.toBe("foreign lock");
                if (scenario === "nativeAtQuit")
                    await expect(
                        readFile(path.join(gitDir, "REVERT_HEAD"), "utf8"),
                        "foreign native changes must stop before quit clears the recorded operation",
                    ).resolves.toBe(`${commit}\n`);
                if (scenario === "recoveryCollision")
                    expect(
                        await readFile(path.join(root, ".intelligit-recovery", id, "0"), "utf8"),
                        "foreign recovery bytes must not be overwritten",
                    ).toBe("foreign recovery bytes\n");
                if (scenario !== "foreignLock" && scenario !== "replacedLock")
                    await expect(
                        lstat(path.join(gitDir, "index.lock")),
                        "a refused abort must release the index lock it created",
                    ).rejects.toThrow("ENOENT");
                if (scenario === "foreignInstall")
                    await expect(
                        readFile(path.join(root, ".intelligit-recovery", id, "0.install"), "utf8"),
                        "a foreign install temporary must not be replaced",
                    ).resolves.toBe("foreign\n");
                if (scenario !== "nativeAtPublication") return;
            }
            if (scenario === "nativeAtPublication") {
                // The refusal was transient; Git writes the index again before the user retries.
                await unlink(path.join(gitDir, "MERGE_HEAD"));
                await writeFile(path.join(root, "unrelated"), "new staged\n");
                await git.run(["add", "unrelated"]);
                await writeFile(path.join(root, "unrelated"), "new working\n");
                const retried = store.get(root);
                await expect(
                    abortTargetNativeOperation(git, persistence, store, lease, {
                        id,
                        revision: retried.revision,
                        expectedPhase: retried.pendingTargetOperation!.phase,
                    }),
                    "a retry after a refused publication must start the index step over",
                ).resolves.toBeUndefined();
            } else if (crashOccurrence && stop) {
                const closeRace =
                    scenario === "dead owner filled lock replaced as its read closes stays busy";
                const readRace =
                    closeRace ||
                    scenario === "dead owner filled lock replaced while read stays busy";
                if (readRace) {
                    lockRead.when = closeRace ? "close" : "read";
                    lockRead.swap = async (file) => {
                        await unlink(file);
                        await writeFile(file, "foreign lock");
                    };
                }
                ({ store, lease } = await restartNativeRecoveryAfterProcessExit(
                    root,
                    lease,
                    stop,
                    crashOccurrence,
                    busy ?? false,
                    candidate,
                    lock,
                ));
                if (readRace) {
                    expect(lockRead.swap, "precondition: recovery read index.lock").toBeUndefined();
                    await expect(
                        readFile(path.join(gitDir, "index.lock"), "utf8"),
                        "a lock replaced while recovery reads it must never be deleted",
                    ).resolves.toBe("foreign lock");
                }
                if (busy) return;
            } else if (stop) {
                await expect(
                    abort(),
                    "pending operation must survive abort checkpoint acknowledgement",
                ).rejects.toThrow(`interrupted:${stop}`);
                await lease.release();
                store = new ChangelistStore();
                await store.connect(root, gitDir);
                lease = await store.acquireTargetOperationLease(root);
                const recovered = store.get(root);
                if (recovered.pendingTargetOperation)
                    await expect(
                        abortTargetNativeOperation(git, persistence, store, lease, {
                            id,
                            revision: recovered.revision,
                            expectedPhase: recovered.pendingTargetOperation.phase,
                        }),
                        "a restarted abort must finish from the last durable checkpoint",
                    ).resolves.toBeUndefined();
            } else
                await expect(
                    abort(),
                    "native abort must restore all reviewed state",
                ).resolves.toBeUndefined();
            expect(
                await readFile(path.join(root, "affected"), "utf8"),
                "abort must restore the exact affected before bytes",
            ).toBe("current\n");
            expect((await git.run(["rev-parse", "HEAD"])).trim()).toBe(before.head);
            expect(await git.run(["ls-files", "-u"]), "abort must remove all conflict stages").toBe(
                "",
            );
            expect(
                (await captureTargetNativeEvidence(git, persistence, id, ["affected"])).index,
                "every restored affected mode and OID must match before",
            ).toEqual(before.index);
            const restaged = ["unrelatedAtLock", "nativeAtPublication"].includes(scenario);
            expect(
                await git.run(["show", ":unrelated"]),
                "unrelated staged content must survive",
            ).toBe(restaged ? "new staged\n" : "staged\n");
            expect(
                await readFile(path.join(root, "unrelated"), "utf8"),
                "unrelated working content must survive",
            ).toBe(restaged ? "new working\n" : "working\n");
            expect(store.get(root).pendingTargetOperation).toBeUndefined();
            expect(store.get(root).targetOperationReceipts?.[id]?.outcome).toBe("aborted");
            expect(
                store.get(root).targetOperationReceipts?.[id],
                "a finished abort releases its evidence to collection",
            ).not.toHaveProperty("evidenceHash");
            await expect(
                lstat(path.join(gitDir, "index.lock")),
                "a finished abort must leave no index lock behind",
            ).rejects.toThrow("ENOENT");
            await writeFile(path.join(root, "later"), "later\n");
            await git.run(["add", "later"]);
        } finally {
            await lease.release();
        }
    },
    120_000,
);
