import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import {
    chmod,
    lstat,
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    stat,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ChangelistPersistence,
    ChangelistEvidenceError,
} from "../../../src/changes/changelistPersistence";
import {
    ChangelistStore,
    type PrepareTargetOperationRequest,
} from "../../../src/changes/changelistStore";
import { changeFingerprint } from "../../../src/changes/parseDiff";
import { reconcileRanges } from "../../../src/changes/rangeMapping";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryLockBusyError } from "../../../src/git/repositoryLock";
import type {
    ChangelistState,
    RangeSnapshot,
} from "../../../src/webviews/protocol/changeSelection";
import type {
    TargetOperationEvidence,
    TargetOperationReceipt,
    TargetOperationRecord,
    TargetPathIdentity,
} from "../../../src/changes/targetOperation";
import { parseTargetOperationEvidence } from "../../../src/changes/targetOperation";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const operationId = "00000000-0000-4000-8000-000000000001";
const receiptId = "00000000-0000-4000-8000-000000000002";
const destinationId = "00000000-0000-4000-8000-000000000003";
const hash = (value: string) => value.repeat(64);
const head = "1".repeat(40);
const baselineRevision = "23464b48c7d47ae4f83429898c6df49b56faf0d3";
const baselineBundleChecksum = "2b963c404643c83e2287a49c21dd63516cbb0087e94f697b8fa19f5fae183eb0";
const baselineFixtureDirectory = path.resolve("tests/fixtures/changes/schema4");

vi.mock("node:fs/promises", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let directory: string;
let root: string;
let gitDir: string;
let BaselineChangelistStore: typeof ChangelistStore;
let baselineManifest: {
    fixtureVersion: number;
    originRevision: string;
    entrypoint: string;
    bundle: string;
    bundleSha256: string;
};

beforeAll(async () => {
    baselineManifest = JSON.parse(
        await readFile(path.join(baselineFixtureDirectory, "manifest.json"), "utf8"),
    );
    const bundle = await readFile(path.join(baselineFixtureDirectory, baselineManifest.bundle));
    if (createHash("sha256").update(bundle).digest("hex") !== baselineBundleChecksum)
        throw new Error("Schema 4 baseline fixture checksum mismatch.");
    BaselineChangelistStore = createRequire(import.meta.url)(
        path.join(baselineFixtureDirectory, baselineManifest.bundle),
    ).ChangelistStore;
});

beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "intelligit-target-operation-"));
    root = path.join(directory, "repository");
    gitDir = path.join(root, ".git");
    await mkdir(gitDir, { recursive: true });
    root = await realpath(root);
    gitDir = await realpath(gitDir);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await removeScratchDirectories(directory);
});

function record(evidenceHash: string): TargetOperationRecord {
    return {
        version: 1,
        id: operationId,
        requestHash: hash("a"),
        beforeEvidenceHash: evidenceHash,
        kind: "shelfRestore",
        phase: "prepared",
        destinationId,
        createdDestination: false,
        headBefore: head,
        evidenceHash,
        shelf: {
            id: "shelf_1",
            generation: 2,
            checksum: hash("c"),
            changeIds: ["change-1"],
            removeFromShelf: true,
        },
        draftChoice: { kind: "keep" },
    };
}

function evidence(id: string, contentHash: string, contentSize = 4): TargetOperationEvidence {
    return {
        version: 1,
        operationId: id,
        root,
        gitDir,
        checkpoint: "before",
        head,
        indexFingerprint: hash("d"),
        paths: [
            {
                path: "src/file.ts",
                state: {
                    kind: "regular",
                    executable: false,
                    content: { hash: contentHash, size: contentSize },
                    identity: {
                        device: "1",
                        inode: "2",
                        size: contentSize,
                        modifiedNs: "3",
                        changedNs: "4",
                    },
                },
            },
        ],
        index: [],
        native: [
            { name: "cherryPickHead", present: false },
            { name: "revertHead", present: false },
            { name: "mergeHead", present: false },
            { name: "sequencer", present: false },
        ],
        entries: [{ changeId: "change-1", path: "src/file.ts", outcome: "pending" }],
    };
}

function receipt(id: string, evidenceHash: string): TargetOperationReceipt {
    return {
        version: 1,
        id,
        requestHash: hash("a"),
        outcome: "applied",
        evidenceHash,
    };
}

async function pathIdentity(filename: string): Promise<TargetPathIdentity> {
    const details = await lstat(filename, { bigint: true });
    return {
        device: String(details.dev),
        inode: String(details.ino),
        size: Number(details.size),
        modifiedNs: String(details.mtimeNs),
        changedNs: String(details.ctimeNs),
    };
}

function gitObjectOid(contents: Uint8Array, type: "blob" | "commit", algorithm = "sha1") {
    const header = Buffer.from(`${type} ${contents.byteLength}\0`);
    return createHash(algorithm).update(header).update(contents).digest("hex");
}

/** Two connected stores share real evidence and metadata but no process-local lease token. */
async function transactionFixture() {
    const first = new ChangelistStore();
    const second = new ChangelistStore();
    await first.connect(root, gitDir);
    await second.connect(root, gitDir);
    const persistence = await ChangelistPersistence.open(root, gitDir);
    const contentHash = await persistence.storeTargetOperationObject(Buffer.from("data"));
    const before = evidence(operationId, contentHash);
    const evidenceHash = await persistence.storeTargetOperationEvidence(before);
    const request: PrepareTargetOperationRequest = {
        id: operationId,
        kind: "shelfRestore",
        target: { kind: "new", name: "  Destination  ", revision: first.revision(root) },
        headBefore: head,
        evidenceHash,
        shelf: record(evidenceHash).shelf,
        draftChoice: { kind: "copySource", sourceListId: "default", expectedDestinationDraft: "" },
        sourceDraft: "captured shelf draft",
    };
    return { first, second, persistence, before, request };
}

/** Captured text hashes and exact changed coordinates exercise the production attribution mapper. */
function attributionSnapshot(
    base: string[],
    working: string[],
    additions: number[],
    removals: number[] = [],
): RangeSnapshot {
    const baseLines = base.map(changeFingerprint);
    const workingLines = working.map(changeFingerprint);
    return {
        contentId: changeFingerprint(JSON.stringify([base, working])),
        baseHash: changeFingerprint(base.join("")),
        workingHash: changeFingerprint(working.join("")),
        head,
        indexHash: changeFingerprint("index"),
        baseLines,
        workingLines,
        anchors: [
            ...removals.map((line) => ({ kind: "remove" as const, line })),
            ...additions.map((line) => ({ kind: "add" as const, line })),
        ].map((anchor, number) => {
            const lines = anchor.kind === "add" ? workingLines : baseLines;
            return {
                ...anchor,
                id: `0:${number}`,
                fingerprint: changeFingerprint(
                    JSON.stringify([anchor.kind, anchor.line, lines[anchor.line]]),
                ),
                hash: lines[anchor.line],
                context: lines.slice(Math.max(0, anchor.line - 2), anchor.line + 3),
            };
        }),
    };
}

/** Immutable attribution fixture has the same before bytes as the durable operation fixture. */
function attributionPayload() {
    const before = attributionSnapshot(["base\n"], ["data"], [0], [0]);
    return {
        version: 1 as const,
        root,
        gitDir,
        operationId,
        path: "src/file.ts",
        priorFileOwner: "default",
        previous: reconcileRanges(undefined, before, "default", "default"),
        before,
        after: attributionSnapshot(["base\n"], ["op\n", "data"], [0, 1], [0]),
        operation: attributionSnapshot(["data"], ["op\n", "data"], [0]),
    };
}

describe("target operation durable attribution", () => {
    it("retains validated attribution payloads through pending and terminal receipt GC roots", async () => {
        const { first, second, persistence, before, request } = await transactionFixture();
        const payload = attributionPayload();
        const bytes = Buffer.from(JSON.stringify(payload));
        const reference = {
            path: payload.path,
            changeIds: ["change-1"],
            object: {
                hash: await persistence.storeTargetOperationObject(bytes),
                size: bytes.byteLength,
            },
        };
        const after = {
            ...before,
            checkpoint: "after" as const,
            previousEvidenceHash: request.evidenceHash,
            entries: before.entries.map((entry) => ({ ...entry, outcome: "applied" as const })),
            attribution: [reference],
        };
        const afterHash = await persistence.storeTargetOperationEvidence(after);
        const state = {
            ...first.get(root),
            revision: 1,
            pendingTargetOperation: {
                ...record(afterHash),
                destinationId: "default",
                beforeEvidenceHash: request.evidenceHash,
                phase: "gitApplied" as const,
                headAfter: head,
            },
        };
        const release = await persistence.acquire();
        try {
            await persistence.write(state);
            await persistence.collect(undefined, state);
        } finally {
            await release();
        }
        const reopened = await ChangelistPersistence.open(root, gitDir);
        expect(
            await reopened.loadTargetOperationAttribution(reference, operationId),
            "reopen hydrates the original owner decisions and all three snapshots",
        ).toEqual(payload);
        const terminal: ChangelistState = {
            ...second.get(root),
            revision: 2,
            targetOperationReceipts: { [operationId]: receipt(operationId, afterHash) },
        };
        delete terminal.pendingTargetOperation;
        const releaseTerminal = await reopened.acquire();
        try {
            await reopened.write(terminal);
            await reopened.collect(state, terminal);
        } finally {
            await releaseTerminal();
        }
        expect(await reopened.loadTargetOperationAttribution(reference, operationId)).toEqual(
            payload,
        );
    });

    it.each(["root", "operationId", "path", "before", "previous"] as const)(
        "refuses corrupt %s attribution before publishing its checkpoint",
        async (field) => {
            const { first, persistence, before, request } = await transactionFixture();
            const payload = attributionPayload();
            const corrupted = {
                ...payload,
                [field]:
                    field === "before"
                        ? { ...payload.before, workingLines: [] }
                        : field === "previous"
                          ? { ...payload.previous, lines: { unsafe: "default" } }
                          : "foreign",
            };
            const bytes = Buffer.from(JSON.stringify(corrupted));
            const reference = {
                path: payload.path,
                changeIds: ["change-1"],
                object: {
                    hash: await persistence.storeTargetOperationObject(bytes),
                    size: bytes.byteLength,
                },
            };
            const unchanged = first.get(root);
            await expect(
                persistence.storeTargetOperationEvidence({
                    ...before,
                    checkpoint: "after",
                    previousEvidenceHash: request.evidenceHash,
                    attribution: [reference],
                }),
                "a checksum-valid object must still contain valid bound attribution",
            ).rejects.toBeInstanceOf(ChangelistEvidenceError);
            expect(first.get(root)).toEqual(unchanged);
        },
    );
});

/** Read the real one-path text fixture, including every index stage and the native marker changed by these tests. */
async function observeTextFixture(
    persistence: ChangelistPersistence,
    template: TargetOperationEvidence,
): Promise<TargetOperationEvidence> {
    const run = (args: string[]) => execFileSync("git", args, { cwd: root, timeout: 10_000 });
    const file = path.join(root, "src/file.ts");
    const bytes = await readFile(file);
    const index: TargetOperationEvidence["index"][number][] = [];
    for (const entry of run(["ls-files", "--stage", "-z", "--", "src/file.ts"])
        .toString("utf8")
        .split("\0")
        .filter(Boolean)) {
        const match = /^(\d+) ([a-f0-9]+) ([0-3])\tsrc\/file\.ts$/.exec(entry)!;
        const object = run(["cat-file", "blob", match[2]]);
        index.push({
            path: "src/file.ts",
            mode: match[1] as "100644",
            oid: match[2],
            stage: Number(match[3]) as 0 | 1 | 2 | 3,
            object: {
                hash: await persistence.storeTargetOperationObject(object),
                size: object.byteLength,
            },
            assumeUnchanged: false,
            skipWorktree: false,
            intentToAdd: false,
        });
    }
    const marker = await readFile(path.join(gitDir, "CHERRY_PICK_HEAD")).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        },
    );
    return {
        ...template,
        head: run(["rev-parse", "HEAD"]).toString("utf8").trim(),
        indexFingerprint: changeFingerprint(await readFile(path.join(gitDir, "index"))),
        index,
        paths: [
            {
                path: "src/file.ts",
                state: {
                    kind: "regular",
                    executable: false,
                    content: {
                        hash: await persistence.storeTargetOperationObject(bytes),
                        size: bytes.byteLength,
                    },
                    identity: await pathIdentity(file),
                },
            },
        ],
        native: template.native.map((control) =>
            control.name === "cherryPickHead"
                ? marker
                    ? { name: control.name, present: true, hash: changeFingerprint(marker) }
                    : { name: control.name, present: false }
                : control,
        ),
    };
}

/** Real file/index observations accompany one real Git apply; no shelf service is mocked or claimed. */
async function ownershipFixture(
    outcome: "applied" | "refused" = "applied",
    partial = false,
    removeFromShelf = true,
    checkpointCount = 1,
    shelfFree = false,
) {
    execFileSync("git", ["init", "-q", root], { timeout: 10_000 });
    await mkdir(path.join(root, "src"));
    const file = path.join(root, "src/file.ts");
    await writeFile(file, "base\n");
    execFileSync("git", ["add", "src/file.ts"], { cwd: root, timeout: 10_000 });
    execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"],
        { cwd: root, timeout: 10_000 },
    );
    await writeFile(file, "data");
    const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
    }).trim();
    const indexFingerprint = changeFingerprint(await readFile(path.join(gitDir, "index")));
    const { first, second, persistence, before, request } = await transactionFixture();
    const payload = attributionPayload();
    for (const snapshot of [payload.before, payload.after, payload.operation]) {
        snapshot.head = actualHead;
        snapshot.indexHash = indexFingerprint;
    }
    const otherState = await first.create(root, first.revision(root), "Other owner");
    const otherId = otherState.lists.find((list) => list.name === "Other owner")!.id;
    await first.saveDraft(root, otherId, "", "other draft");
    await first.track(root, payload.path, payload.before);
    await first.assignChanges(
        root,
        first.revision(root),
        payload.path,
        payload.before.contentId,
        otherId,
        [payload.before.anchors[0].fingerprint],
        new Set(payload.before.anchors.map((anchor) => anchor.fingerprint)),
    );
    await first.recordSelection(
        root,
        payload.path,
        payload.before.contentId,
        "default",
        [],
        payload.before.anchors.length,
    );
    const previous = first.get(root).changes[payload.path];
    payload.previous = { ...previous, tracking: payload.before, history: undefined };
    const actualBefore: TargetOperationEvidence = await observeTextFixture(persistence, {
        ...before,
        head: actualHead,
        indexFingerprint,
        entries: partial
            ? [...before.entries, { changeId: "change-2", path: payload.path, outcome: "pending" }]
            : before.entries,
        paths: [
            {
                ...before.paths[0],
                state: {
                    ...before.paths[0].state,
                    identity: await pathIdentity(file),
                } as (typeof before.paths)[0]["state"],
            },
        ],
    });
    const evidenceHash = await persistence.storeTargetOperationEvidence(actualBefore);
    const intent = {
        ...request,
        ...(shelfFree
            ? { kind: "patchApply" as const, draftChoice: undefined, sourceDraft: undefined }
            : {}),
        headBefore: actualHead,
        evidenceHash,
        target: { ...request.target, revision: first.revision(root) },
        shelf: shelfFree
            ? undefined
            : {
                  ...request.shelf!,
                  changeIds: actualBefore.entries.map((entry) => entry.changeId),
                  removeFromShelf,
              },
    };
    const original = first.get(root);
    const lease = await first.acquireTargetOperationLease(root);
    let checkpoint: ChangelistState;
    let after: TargetOperationEvidence;
    let afterHash: string;
    let applyCount = 0;
    try {
        const prepared = (await first.prepareTargetOperation(lease, intent)).state;
        if (outcome === "applied") {
            execFileSync("git", ["apply"], {
                cwd: root,
                timeout: 10_000,
                input: "diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1,2 @@\n+op\n data\n\\ No newline at end of file\n",
            });
            applyCount++;
        }
        const working = await readFile(file);
        const payloadBytes = Buffer.from(JSON.stringify(payload));
        after = {
            ...actualBefore,
            checkpoint: "after",
            previousEvidenceHash: evidenceHash,
            paths: [
                {
                    path: payload.path,
                    state: {
                        kind: "regular",
                        executable: false,
                        content: {
                            hash: await persistence.storeTargetOperationObject(working),
                            size: working.byteLength,
                        },
                        identity: await pathIdentity(file),
                    },
                },
            ],
            entries: actualBefore.entries.map((entry) => ({
                ...entry,
                outcome: entry.changeId === "change-2" ? ("refused" as const) : outcome,
            })),
            attribution:
                outcome === "applied"
                    ? [
                          {
                              path: payload.path,
                              changeIds: ["change-1"],
                              object: {
                                  hash: await persistence.storeTargetOperationObject(payloadBytes),
                                  size: payloadBytes.byteLength,
                              },
                          },
                      ]
                    : [],
        };
        checkpoint = prepared;
        for (let step = 0; step < checkpointCount; step++) {
            afterHash = await persistence.storeTargetOperationEvidence(after);
            checkpoint = await first.checkpointTargetOperation(lease, {
                id: operationId,
                revision: checkpoint.revision,
                expectedPhase: "prepared",
                phase: step === checkpointCount - 1 ? "gitApplied" : "prepared",
                evidenceHash: afterHash,
            });
            if (step < checkpointCount - 1) after = { ...after, previousEvidenceHash: afterHash };
        }
    } finally {
        await lease.release();
    }
    return {
        first,
        second,
        persistence,
        payload,
        original,
        checkpoint: checkpoint!,
        after: after!,
        afterHash: afterHash!,
        otherId,
        file,
        applyCount,
        publication: {
            id: operationId,
            revision: checkpoint!.revision,
            expectedPhase: "gitApplied" as const,
            observedEvidenceHash: checkpointCount ? afterHash! : evidenceHash,
            shelf: {
                id: request.shelf!.id,
                generation: request.shelf!.generation,
                checksum: request.shelf!.checksum,
            },
        },
        request: intent,
    };
}

describe("target operation completion recovery", () => {
    it("finishes a shelf-free patch with a retained replay receipt", async () => {
        const { second, publication, request, file } = await ownershipFixture(
            "applied",
            false,
            false,
            1,
            true,
        );
        const lease = await second.acquireTargetOperationLease(root);
        try {
            const done = await second.recoverTargetOperation(lease, {
                ...publication,
                shelf: undefined,
            });
            expect(done.pendingTargetOperation).toBeUndefined();
            expect(done.targetOperationReceipts?.[operationId]?.outcome).toBe("applied");
            expect(done.lists.find((list) => list.name === "Destination")!.draft).toBe("");
            expect(await second.prepareTargetOperation(lease, request)).toEqual({
                status: "known",
                state: done,
            });
        } finally {
            await lease.release();
        }
        expect(await readFile(file, "utf8")).toBe("op\ndata");
    });

    it.each(["observed state", "shelf identity"])(
        "completion keeps ownership and later draft fenced for changed %s",
        async (changed) => {
            const { second, persistence, publication, file } = await ownershipFixture(
                "applied",
                false,
                false,
            );
            let lease = await second.acquireTargetOperationLease(root);
            let ownership: ChangelistState;
            try {
                ownership = await second.publishTargetOwnership(lease, publication);
            } finally {
                await lease.release();
            }
            const target = ownership!.pendingTargetOperation!.destinationId;
            await second.saveDraft(root, target, "captured shelf draft", "later draft");
            const before = second.get(root);
            let observedEvidenceHash = publication.observedEvidenceHash;
            if (changed === "observed state") {
                await writeFile(file, "external edit");
                const saved = await persistence.loadTargetOperationEvidence(observedEvidenceHash);
                observedEvidenceHash = await persistence.storeTargetOperationEvidence(
                    await observeTextFixture(persistence, saved),
                );
            }
            lease = await second.acquireTargetOperationLease(root);
            try {
                const result = await second.finishTargetOperation(lease, {
                    ...publication,
                    revision: before.revision,
                    expectedPhase: "ownershipPublished",
                    observedEvidenceHash,
                    shelf:
                        changed === "shelf identity"
                            ? { ...publication.shelf, checksum: hash("f") }
                            : publication.shelf,
                });
                expect(
                    result.pendingTargetOperation?.phase,
                    "changed completion observations retain the pending fence",
                ).toBe("reviewRequired");
                expect(result.targetOperationReceipts).toBeUndefined();
                expect(result.changes).toEqual(before.changes);
                expect(result.lists).toEqual(before.lists);
                expect(result.pendingTargetOperation?.completion).toEqual(
                    before.pendingTargetOperation?.completion,
                );
            } finally {
                await lease.release();
            }
        },
    );

    it("zero-success gitApplied recovery retains the fence even when observed state changed", async () => {
        const { second, persistence, checkpoint, publication, file } = await ownershipFixture(
            "refused",
            false,
            false,
        );
        await writeFile(file, "external edit");
        const saved = await persistence.loadTargetOperationEvidence(
            publication.observedEvidenceHash,
        );
        const observedEvidenceHash = await persistence.storeTargetOperationEvidence(
            await observeTextFixture(persistence, saved),
        );
        const lease = await second.acquireTargetOperationLease(root);
        try {
            const result = await second.recoverTargetOperation(lease, {
                ...publication,
                observedEvidenceHash,
            });
            expect(result.pendingTargetOperation?.phase).toBe("reviewRequired");
            expect(result.targetOperationReceipts).toBeUndefined();
            expect(result.lists).toEqual(checkpoint.lists);
        } finally {
            await lease.release();
        }
    });

    it.each(["unchanged", "edited", "used"])(
        "unchanged real prepared recovery retains only an %s created destination when required",
        async (destination) => {
            const { second, persistence, checkpoint, publication, request, file, applyCount } =
                await ownershipFixture("refused", false, true, 0);
            const before = structuredClone(checkpoint);
            const target = before.pendingTargetOperation!.destinationId;
            if (destination === "edited")
                before.lists.find((list) => list.id === target)!.description = "user description";
            if (destination === "used") before.files["unrelated.txt"] = target;
            if (destination !== "unchanged") {
                before.revision++;
                const release = await persistence.acquire();
                try {
                    await persistence.write(before);
                } finally {
                    await release();
                }
            }
            const gitWrites = vi.spyOn(GitExecutor.prototype, "run");
            const index = await readFile(path.join(gitDir, "index"));
            const lease = await second.acquireTargetOperationLease(root);
            try {
                const result = await second.recoverTargetOperation(lease, {
                    ...publication,
                    revision: before.revision,
                    expectedPhase: "prepared",
                });
                expect(
                    result.pendingTargetOperation,
                    "not-applied receipt and pending clear publish together",
                ).toBeUndefined();
                expect(result.targetOperationReceipts?.[operationId]).toMatchObject({
                    outcome: "notApplied",
                    requestHash: requestHash(before),
                    evidenceHash: request.evidenceHash,
                });
                expect(
                    result.lists.some((list) => list.id === target),
                    "only the unchanged empty operation-created list may be removed",
                ).toBe(destination !== "unchanged");
                expect(result.changes).toEqual(before.changes);
                expect(result.files).toEqual(before.files);
                expect(
                    await second.prepareTargetOperation(lease, request),
                    "terminal receipt blocks the original request from becoming fresh",
                ).toEqual({ status: "known", state: result });
            } finally {
                await lease.release();
            }
            const reopened = new ChangelistStore();
            await reopened.connect(root, gitDir);
            expect(reopened.get(root).targetOperationReceipts?.[operationId]?.outcome).toBe(
                "notApplied",
            );
            expect(await readFile(file, "utf8")).toBe("data");
            expect(await readFile(path.join(gitDir, "index"))).toEqual(index);
            expect(applyCount).toBe(0);
            expect(
                gitWrites.mock.calls.filter(([args]) =>
                    ["apply", "reset", "cherry-pick", "revert"].includes(args[0]),
                ),
                "recovery must never execute a Git mutation",
            ).toEqual([]);
        },
    );

    it.each(["HEAD", "index", "path", "native"])(
        "changed real %s keeps prepared recovery fenced for review",
        async (changedPart) => {
            const { second, persistence, checkpoint, publication, file } = await ownershipFixture(
                "refused",
                false,
                true,
                0,
            );
            if (changedPart === "HEAD")
                execFileSync(
                    "git",
                    [
                        "-c",
                        "user.name=Test",
                        "-c",
                        "user.email=test@example.com",
                        "commit",
                        "--allow-empty",
                        "-qm",
                        "external",
                    ],
                    { cwd: root, timeout: 10_000 },
                );
            if (changedPart === "index")
                execFileSync("git", ["add", "src/file.ts"], { cwd: root, timeout: 10_000 });
            if (changedPart === "path") await writeFile(file, "external content");
            if (changedPart === "native")
                await writeFile(
                    path.join(gitDir, "CHERRY_PICK_HEAD"),
                    `${checkpoint.pendingTargetOperation!.headBefore}\n`,
                );
            const saved = await persistence.loadTargetOperationEvidence(
                checkpoint.pendingTargetOperation!.evidenceHash,
            );
            const observed = await observeTextFixture(persistence, saved);
            const observedEvidenceHash = await persistence.storeTargetOperationEvidence(observed);
            const lease = await second.acquireTargetOperationLease(root);
            try {
                const result = await second.recoverTargetOperation(lease, {
                    ...publication,
                    expectedPhase: "prepared",
                    observedEvidenceHash,
                });
                expect(
                    result.pendingTargetOperation?.phase,
                    "zero successful entries cannot prove unchanged Git state",
                ).toBe("reviewRequired");
                expect(result.targetOperationReceipts).toBeUndefined();
                expect(result.lists).toEqual(checkpoint.lists);
                expect(result.changes).toEqual(checkpoint.changes);
            } finally {
                await lease.release();
            }
            expect(await observeTextFixture(persistence, observed)).toEqual(observed);
        },
    );

    it.each(["before", "after"])(
        "terminal receipt survives %s-publication failure without draft recopy or Git replay",
        async (failure) => {
            const { first, second, persistence, publication, file, request, applyCount } =
                await ownershipFixture("applied", false, false);
            let lease = await first.acquireTargetOperationLease(root);
            let ownership: ChangelistState;
            try {
                ownership = await first.publishTargetOwnership(lease, publication);
            } finally {
                await lease.release();
            }
            const target = ownership!.pendingTargetOperation!.destinationId;
            await second.saveDraft(root, target, "captured shelf draft", "later draft");
            const later = second.get(root);
            const write = ChangelistPersistence.prototype.write;
            let failed = false;
            vi.spyOn(ChangelistPersistence.prototype, "write").mockImplementation(
                async function (state) {
                    if (
                        !failed &&
                        !state.pendingTargetOperation &&
                        state.targetOperationReceipts?.[operationId]
                    ) {
                        failed = true;
                        if (failure === "after") await write.call(this, state);
                        throw new Error("terminal receipt interruption");
                    }
                    return write.call(this, state);
                },
            );
            lease = await second.acquireTargetOperationLease(root);
            try {
                await expect(
                    second.finishTargetOperation(lease, {
                        ...publication,
                        revision: later.revision,
                        expectedPhase: "ownershipPublished",
                    }),
                ).rejects.toThrow("terminal receipt interruption");
            } finally {
                await lease.release();
            }
            vi.restoreAllMocks();
            const reopened = new ChangelistStore();
            await reopened.connect(root, gitDir);
            lease = await reopened.acquireTargetOperationLease(root);
            try {
                const state = reopened.get(root);
                const done = await reopened.recoverTargetOperation(lease, {
                    ...publication,
                    revision: state.revision,
                    expectedPhase: state.pendingTargetOperation?.phase ?? "ownershipPublished",
                });
                expect(
                    done.pendingTargetOperation,
                    "terminal receipt and pending clear are atomic after reopen",
                ).toBeUndefined();
                expect(done.targetOperationReceipts?.[operationId]).toMatchObject({
                    outcome: "applied",
                    requestHash: requestHash(ownership!),
                });
                expect(
                    done.lists.find((list) => list.id === target)!.draft,
                    "completion recovery never recopies the source draft",
                ).toBe("later draft");
                expect(await reopened.prepareTargetOperation(lease, request)).toEqual({
                    status: "known",
                    state: done,
                });
                await persistence.validateEvidence(done);
            } finally {
                await lease.release();
            }
            expect(await readFile(file, "utf8")).toBe("op\ndata");
            expect(applyCount).toBe(1);
        },
    );

    it("matching gitApplied recovery completes ownership and reusable-copy receipt without another Git apply", async () => {
        const { second, publication, file, applyCount } = await ownershipFixture(
            "applied",
            false,
            false,
        );
        const lease = await second.acquireTargetOperationLease(root);
        try {
            const result = await second.recoverTargetOperation(lease, publication);
            expect(result.pendingTargetOperation).toBeUndefined();
            expect(result.targetOperationReceipts?.[operationId]?.outcome).toBe("applied");
            expect(result.lists.find((list) => list.name === "Destination")!.draft).toBe(
                "captured shelf draft",
            );
        } finally {
            await lease.release();
        }
        expect(await readFile(file, "utf8")).toBe("op\ndata");
        expect(applyCount).toBe(1);
    });

    it("refuses removal-required finish even when phase text claims shelfPublished", async () => {
        const { second, persistence, publication } = await ownershipFixture();
        let lease = await second.acquireTargetOperationLease(root);
        let ownership: ChangelistState;
        try {
            ownership = await second.publishTargetOwnership(lease, publication);
        } finally {
            await lease.release();
        }
        const claimed = {
            ...ownership!,
            pendingTargetOperation: {
                ...ownership!.pendingTargetOperation!,
                phase: "shelfPublished" as const,
                completion: {
                    ...ownership!.pendingTargetOperation!.completion!,
                    shelfPublication: "published" as const,
                    publishedGeneration: 3,
                    publishedChecksum: hash("e"),
                },
            },
        };
        const release = await persistence.acquire();
        try {
            await persistence.write(claimed);
        } finally {
            await release();
        }
        lease = await second.acquireTargetOperationLease(root);
        try {
            await expect(
                second.finishTargetOperation(lease, {
                    ...publication,
                    revision: claimed.revision,
                    expectedPhase: "shelfPublished",
                }),
                "phase text cannot substitute for a concrete shelf publication receipt",
            ).rejects.toThrow(/shelf.*receipt/i);
            expect(second.get(root)).toEqual(claimed);
        } finally {
            await lease.release();
        }
    });
});

/** Stable request identity is copied into receipts, never regenerated from current metadata. */
function requestHash(state: ChangelistState): string {
    return state.pendingTargetOperation!.requestHash;
}

describe("target operation ownership publication", () => {
    it("reviewed Keep publishes ownership without overwriting the edited draft or original request identity", async () => {
        const { second, persistence, checkpoint, publication } = await ownershipFixture();
        const changed = structuredClone(checkpoint);
        const target = changed.pendingTargetOperation!.destinationId;
        changed.lists.find((list) => list.id === target)!.draft = "edited while Git completed";
        changed.revision++;
        const release = await persistence.acquire();
        try {
            await persistence.write(changed);
        } finally {
            await release();
        }
        const lease = await second.acquireTargetOperationLease(root);
        try {
            const review = await second.publishTargetOwnership(lease, {
                ...publication,
                revision: changed.revision,
            });
            expect(review.pendingTargetOperation?.phase).toBe("reviewRequired");
            const reviewedDraft = {
                kind: "keep" as const,
                expectedDestinationDraft: "edited while Git completed",
            };
            await expect(
                second.publishTargetOwnership(lease, {
                    ...publication,
                    revision: changed.revision,
                    expectedPhase: "reviewRequired",
                    reviewedDraft,
                }),
                "stale Keep consent cannot publish",
            ).rejects.toThrow(/changed|refresh/i);
            const kept = await second.publishTargetOwnership(lease, {
                ...publication,
                revision: review.revision,
                expectedPhase: "reviewRequired",
                reviewedDraft,
            });
            expect(kept.pendingTargetOperation).toMatchObject({
                phase: "ownershipPublished",
                requestHash: checkpoint.pendingTargetOperation!.requestHash,
                draftChoice: checkpoint.pendingTargetOperation!.draftChoice,
                sourceDraft: checkpoint.pendingTargetOperation!.sourceDraft,
                completion: { draft: "keptAfterReview", appliedChangeIds: ["change-1"] },
            });
            expect(
                kept.lists.find((list) => list.id === target)!.draft,
                "reviewed Keep never copies captured shelf text",
            ).toBe("edited while Git completed");
            expect(kept.changes).not.toEqual(checkpoint.changes);
        } finally {
            await lease.release();
        }
    });

    it.each(["observed state", "attribution"])(
        "reviewed Keep cannot authorize mismatched %s",
        async (mismatch) => {
            const { second, persistence, checkpoint, publication, after } =
                await ownershipFixture();
            let observedEvidenceHash = publication.observedEvidenceHash;
            if (mismatch === "observed state")
                observedEvidenceHash = await persistence.storeTargetOperationEvidence({
                    ...after,
                    indexFingerprint: hash("e"),
                });
            else {
                const evidenceHash = await persistence.storeTargetOperationEvidence({
                    ...after,
                    attribution: [],
                });
                const release = await persistence.acquire();
                try {
                    await persistence.write({
                        ...checkpoint,
                        pendingTargetOperation: {
                            ...checkpoint.pendingTargetOperation!,
                            evidenceHash,
                        },
                    });
                } finally {
                    await release();
                }
                observedEvidenceHash = evidenceHash;
            }
            const lease = await second.acquireTargetOperationLease(root);
            try {
                const review = await second.markTargetOperationReview(lease, {
                    id: operationId,
                    revision: checkpoint.revision,
                    expectedPhase: "gitApplied",
                });
                const result = await second.publishTargetOwnership(lease, {
                    ...publication,
                    observedEvidenceHash,
                    revision: review.revision,
                    expectedPhase: "reviewRequired",
                    reviewedDraft: { kind: "keep", expectedDestinationDraft: "" },
                });
                expect(
                    result,
                    "Keep only decides the draft and cannot bypass operation evidence",
                ).toEqual(review);
            } finally {
                await lease.release();
            }
        },
    );
    it("validates a multistep checkpoint chain within a linear evidence-read bound", async () => {
        const checkpoints = 8;
        const { second, publication, checkpoint, file, applyCount } = await ownershipFixture(
            "applied",
            false,
            true,
            checkpoints,
        );
        const opened = vi.spyOn(fs, "open");
        const lease = await second.acquireTargetOperationLease(root);
        let published: ChangelistState;
        try {
            published = await second.publishTargetOwnership(lease, publication);
        } finally {
            await lease.release();
        }
        const manifests = opened.mock.calls
            .map(([filename]) => String(filename))
            .filter((filename) => filename.endsWith(".operation.json"));
        expect(new Set(manifests).size, "every immutable checkpoint is validated").toBe(
            checkpoints + 1,
        );
        expect(
            manifests.some((filename) =>
                filename.endsWith(
                    `${checkpoint.pendingTargetOperation!.beforeEvidenceHash}.operation.json`,
                ),
            ),
            "the original before checkpoint remains validated",
        ).toBe(true);
        expect(
            manifests.length,
            "ownership validates each checkpoint at most four times, never every ancestor suffix",
        ).toBeLessThanOrEqual(4 * (checkpoints + 1));
        expect(published!.pendingTargetOperation?.phase).toBe("ownershipPublished");
        expect(await readFile(file, "utf8")).toBe("op\ndata");
        expect(applyCount).toBe(1);
    });
    it("freezes only successful entries and records no shelf lifecycle publication for reusable copy", async () => {
        const { second, publication, checkpoint } = await ownershipFixture("applied", true, false);
        const lease = await second.acquireTargetOperationLease(root);
        try {
            const result = await second.publishTargetOwnership(lease, publication);
            expect(result.pendingTargetOperation?.completion).toMatchObject({
                appliedChangeIds: ["change-1"],
                shelfPublication: "notRequired",
            });
            expect(result.pendingTargetOperation?.shelf).toEqual(
                checkpoint.pendingTargetOperation?.shelf,
            );
            expect(
                result.targetOperationReceipts,
                "ownership never clears pending or claims terminal completion",
            ).toBeUndefined();
        } finally {
            await lease.release();
        }
    });
    it.each(["before", "after"])(
        "publishes mixed ownership and captured draft once across %s-publication failure and reopen",
        async (failure) => {
            const fixture = await ownershipFixture();
            const { first, second, payload, original, otherId, publication, file, applyCount } =
                fixture;
            const persistedWrite = ChangelistPersistence.prototype.write;
            let failed = false;
            vi.spyOn(ChangelistPersistence.prototype, "write").mockImplementation(
                async function (state) {
                    if (!failed && state.pendingTargetOperation?.phase === "ownershipPublished") {
                        failed = true;
                        if (failure === "after") await persistedWrite.call(this, state);
                        throw new Error("ownership publication interruption");
                    }
                    return persistedWrite.call(this, state);
                },
            );
            let lease = await first.acquireTargetOperationLease(root);
            try {
                await expect(first.publishTargetOwnership(lease, publication)).rejects.toThrow(
                    "ownership publication interruption",
                );
            } finally {
                await lease.release();
            }
            vi.restoreAllMocks();
            const reopened = new ChangelistStore();
            await reopened.connect(root, gitDir);
            lease = await reopened.acquireTargetOperationLease(root);
            let published: ChangelistState;
            try {
                const state = reopened.get(root);
                published = await reopened.publishTargetOwnership(lease, {
                    ...publication,
                    revision: state.revision,
                    expectedPhase: state.pendingTargetOperation!.phase,
                });
            } finally {
                await lease.release();
            }
            const target = published!.pendingTargetOperation!.destinationId;
            expect(published!.pendingTargetOperation).toMatchObject({
                phase: "ownershipPublished",
                completion: {
                    appliedChangeIds: ["change-1"],
                    draft: "copied",
                    shelfPublication: "pending",
                    ownershipRevision: published!.revision,
                },
            });
            expect(published!.files[payload.path], "pre-existing file owner is preserved").toBe(
                "default",
            );
            expect(published!.changes[payload.path].lines).toEqual({
                [payload.after.anchors[0].fingerprint]: otherId,
                [payload.after.anchors[1].fingerprint]: target,
            });
            expect(
                published!.changes[payload.path].lines[payload.after.anchors[2].fingerprint] ??
                    published!.files[payload.path],
                "unassigned pre-existing addition retains the file fallback owner",
            ).toBe("default");
            expect(
                published!.changes[payload.path].selections?.default.lineIds,
                "explicit exclusion survives attribution",
            ).toEqual([]);
            expect(published!.activeId).toBe(original.activeId);
            expect(published!.lists.find((list) => list.id === otherId)).toEqual(
                original.lists.find((list) => list.id === otherId),
            );
            expect(published!.lists.find((list) => list.id === target)!.draft).toBe(
                "captured shelf draft",
            );
            await second.saveDraft(
                root,
                target,
                "captured shelf draft",
                "user draft after publication",
            );
            const later = second.get(root);
            lease = await reopened.acquireTargetOperationLease(root);
            try {
                const review = await reopened.markTargetOperationReview(lease, {
                    id: operationId,
                    revision: later.revision,
                    expectedPhase: "ownershipPublished",
                });
                expect(
                    await reopened.publishTargetOwnership(lease, {
                        ...publication,
                        revision: review.revision,
                        expectedPhase: "reviewRequired",
                    }),
                    "completed ownership skips both attribution and draft copy during review",
                ).toEqual(review);
            } finally {
                await lease.release();
            }
            expect(second.get(root).lists.find((list) => list.id === target)!.draft).toBe(
                "user draft after publication",
            );
            expect(await readFile(file, "utf8")).toBe("op\ndata");
            expect(applyCount, "one real Git apply across publication and reopen").toBe(1);
        },
    );

    it("rejects zero successful entries without copying a draft or clearing changed pending state", async () => {
        const { second, persistence, after, publication, checkpoint, file } =
            await ownershipFixture("refused");
        await writeFile(file, "external change");
        const working = await readFile(file);
        const observation = {
            ...after,
            paths: [
                {
                    path: "src/file.ts",
                    state: {
                        kind: "regular" as const,
                        executable: false,
                        content: {
                            hash: await persistence.storeTargetOperationObject(working),
                            size: working.byteLength,
                        },
                        identity: await pathIdentity(file),
                    },
                },
            ],
        };
        const observedEvidenceHash = await persistence.storeTargetOperationEvidence(observation);
        const lease = await second.acquireTargetOperationLease(root);
        try {
            await expect(
                second.publishTargetOwnership(lease, { ...publication, observedEvidenceHash }),
                "zero success is never ownership or not-applied proof",
            ).rejects.toThrow(/no successful entries/i);
            expect(second.get(root), "no destination draft copy or pending clear").toEqual(
                checkpoint,
            );
        } finally {
            await lease.release();
        }
        expect(await readFile(file, "utf8")).toBe("external change");
    });

    it.each([
        "shelf checksum",
        "observed paths",
        "captured ownership",
        "missing attribution",
        "before root",
        "snapshot bytes",
        "destination draft",
    ])("preserves ownership and drafts for %s mismatch", async (mismatch) => {
        const { second, persistence, payload, after, afterHash, publication, checkpoint } =
            await ownershipFixture();
        let observedEvidenceHash = afterHash;
        if (mismatch === "observed paths") {
            observedEvidenceHash = await persistence.storeTargetOperationEvidence({
                ...after,
                indexFingerprint: hash("e"),
            });
        }
        if (
            mismatch === "captured ownership" ||
            mismatch === "missing attribution" ||
            mismatch === "snapshot bytes"
        ) {
            if (mismatch === "captured ownership") payload.previous.lines = {};
            if (mismatch === "snapshot bytes") payload.after.workingHash = hash("e");
            const bytes = Buffer.from(JSON.stringify(payload));
            const changed = {
                ...after,
                attribution:
                    mismatch === "missing attribution"
                        ? []
                        : [
                              {
                                  ...after.attribution![0],
                                  object: {
                                      hash: await persistence.storeTargetOperationObject(bytes),
                                      size: bytes.byteLength,
                                  },
                              },
                          ],
            };
            const changedHash = await persistence.storeTargetOperationEvidence(changed);
            const release = await persistence.acquire();
            try {
                await persistence.write({
                    ...checkpoint,
                    pendingTargetOperation: {
                        ...checkpoint.pendingTargetOperation!,
                        evidenceHash: changedHash,
                    },
                });
            } finally {
                await release();
            }
            observedEvidenceHash = changedHash;
        }
        if (mismatch === "before root" || mismatch === "destination draft") {
            const changed = structuredClone(checkpoint);
            if (mismatch === "before root") {
                const before = await persistence.loadTargetOperationEvidence(
                    checkpoint.pendingTargetOperation!.beforeEvidenceHash,
                );
                const foreign = await persistence.storeTargetOperationEvidence({
                    ...before,
                    indexFingerprint: hash("f"),
                });
                changed.pendingTargetOperation = {
                    ...changed.pendingTargetOperation!,
                    beforeEvidenceHash: foreign,
                };
            } else
                changed.lists.find(
                    (list) => list.id === changed.pendingTargetOperation!.destinationId,
                )!.draft = "external draft edit";
            const release = await persistence.acquire();
            try {
                await persistence.write(changed);
            } finally {
                await release();
            }
        }
        const before = second.get(root);
        const lease = await second.acquireTargetOperationLease(root);
        try {
            const result = await second.publishTargetOwnership(lease, {
                ...publication,
                observedEvidenceHash,
                shelf:
                    mismatch === "shelf checksum"
                        ? { ...publication.shelf, checksum: hash("f") }
                        : publication.shelf,
            });
            expect(
                result.pendingTargetOperation?.phase,
                "mismatch retains operation for review",
            ).toBe("reviewRequired");
            expect(result.changes).toEqual(before.changes);
            expect(result.lists).toEqual(before.lists);
            expect(result.pendingTargetOperation?.completion).toBeUndefined();
        } finally {
            await lease.release();
        }
    });
});

describe("target operation durable transactions", () => {
    it("rejects gitApplied with real unmerged entries while preserving a conflicted checkpoint", async () => {
        execFileSync("git", ["init", "--quiet"], { cwd: root, timeout: 10_000 });
        execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "base",
            ],
            { cwd: root, timeout: 10_000 },
        );
        const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
        }).trim();
        const { first, second, persistence, before, request } = await transactionFixture();
        const actualBefore: TargetOperationEvidence = {
            ...before,
            head: actualHead,
            paths: [{ path: "conflict.txt", state: { kind: "absent" } }],
            entries: [{ changeId: "change-1", path: "conflict.txt", outcome: "pending" }],
        };
        const beforeHash = await persistence.storeTargetOperationEvidence(actualBefore);
        const lease = await first.acquireTargetOperationLease(root);
        try {
            const { state: prepared } = await first.prepareTargetOperation(lease, {
                ...request,
                headBefore: actualHead,
                evidenceHash: beforeHash,
            });
            const index: TargetOperationEvidence["index"][number][] = [];
            for (const stage of [1, 2, 3] as const) {
                const bytes = Buffer.from(`conflict version ${stage}\n`);
                const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
                    cwd: root,
                    encoding: "utf8",
                    input: bytes,
                    timeout: 10_000,
                }).trim();
                index.push({
                    path: "conflict.txt",
                    stage,
                    mode: "100644",
                    oid,
                    object: {
                        hash: await persistence.storeTargetOperationObject(bytes),
                        size: bytes.byteLength,
                    },
                    assumeUnchanged: false,
                    skipWorktree: false,
                    intentToAdd: false,
                });
            }
            execFileSync("git", ["update-index", "--index-info"], {
                cwd: root,
                timeout: 10_000,
                input: index
                    .map((entry) => `${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\n`)
                    .join(""),
            });
            const indexBytes = await readFile(path.join(gitDir, "index"));
            const conflicted: TargetOperationEvidence = {
                ...actualBefore,
                checkpoint: "after",
                previousEvidenceHash: beforeHash,
                index,
                indexFingerprint: changeFingerprint(indexBytes),
                entries: [{ changeId: "change-1", path: "conflict.txt", outcome: "conflicted" }],
            };
            const conflictHash = await persistence.storeTargetOperationEvidence(conflicted);
            const state = await first.checkpointTargetOperation(lease, {
                id: operationId,
                revision: prepared.revision,
                expectedPhase: "prepared",
                phase: "conflicted",
                evidenceHash: conflictHash,
            });
            expect(state.pendingTargetOperation?.phase).toBe("conflicted");
            expect(
                (await persistence.loadTargetOperationEvidence(conflictHash)).index.map(
                    (entry) => entry.stage,
                ),
            ).toEqual([1, 2, 3]);
            const unresolvedApplied = {
                ...conflicted,
                previousEvidenceHash: conflictHash,
                entries: conflicted.entries.map((entry) => ({
                    ...entry,
                    outcome: "applied" as const,
                })),
            };
            const unresolvedHash =
                await persistence.storeTargetOperationEvidence(unresolvedApplied);
            await expect(
                first.checkpointTargetOperation(lease, {
                    id: operationId,
                    revision: state.revision,
                    expectedPhase: "conflicted",
                    phase: "gitApplied",
                    evidenceHash: unresolvedHash,
                }),
                "gitApplied cannot hide real unmerged stages behind an applied entry outcome",
            ).rejects.toThrow();
            expect(first.get(root)).toEqual(state);
            expect(await readFile(path.join(gitDir, "index"))).toEqual(indexBytes);
        } finally {
            await lease.release();
        }
        expect(second.get(root).pendingTargetOperation?.phase).toBe("conflicted");
    });

    it("refuses markerless unmerged before evidence without publishing a destination or changing Git", async () => {
        execFileSync("git", ["init", "--quiet"], { cwd: root, timeout: 10_000 });
        execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "base",
            ],
            { cwd: root, timeout: 10_000 },
        );
        const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
        }).trim();
        const { first, second, persistence, before, request } = await transactionFixture();
        const index: TargetOperationEvidence["index"][number][] = [];
        for (const stage of [1, 2, 3] as const) {
            const bytes = Buffer.from(`conflict version ${stage}\n`);
            const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
                cwd: root,
                encoding: "utf8",
                input: bytes,
                timeout: 10_000,
            }).trim();
            index.push({
                path: "conflict.txt",
                stage,
                mode: "100644",
                oid,
                object: {
                    hash: await persistence.storeTargetOperationObject(bytes),
                    size: bytes.byteLength,
                },
                assumeUnchanged: false,
                skipWorktree: false,
                intentToAdd: false,
            });
        }
        execFileSync("git", ["update-index", "--index-info"], {
            cwd: root,
            timeout: 10_000,
            input: index
                .map((entry) => `${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\n`)
                .join(""),
        });
        const file = path.join(root, "conflict.txt");
        const working = Buffer.from("keep this unresolved working version\n");
        await writeFile(file, working);
        const indexBytes = await readFile(path.join(gitDir, "index"));
        expect(
            execFileSync("git", ["ls-files", "--unmerged"], {
                cwd: root,
                encoding: "utf8",
                timeout: 10_000,
            })
                .trim()
                .split("\n"),
        ).toHaveLength(3);
        for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"])
            expect(
                await readdir(gitDir),
                `real conflict index has no ${marker} marker`,
            ).not.toContain(marker);
        const actualBefore: TargetOperationEvidence = {
            ...before,
            head: actualHead,
            indexFingerprint: changeFingerprint(indexBytes),
            index,
            paths: [
                {
                    path: "conflict.txt",
                    state: {
                        kind: "regular",
                        executable: false,
                        content: {
                            hash: await persistence.storeTargetOperationObject(working),
                            size: working.byteLength,
                        },
                        identity: await pathIdentity(file),
                    },
                },
            ],
            entries: [{ changeId: "change-1", path: "conflict.txt", outcome: "pending" }],
        };
        const evidenceHash = await persistence.storeTargetOperationEvidence(actualBefore);
        const untouched = first.get(root);
        const lease = await first.acquireTargetOperationLease(root);
        try {
            await expect(
                first.prepareTargetOperation(lease, {
                    ...request,
                    headBefore: actualHead,
                    evidenceHash,
                }),
                "valid stage 1-3 before evidence must refuse prepare even without native markers",
            ).rejects.toThrow();
            expect(
                first.get(root),
                "refused prepare cannot publish a destination or pending record",
            ).toEqual(untouched);
        } finally {
            await lease.release();
        }
        expect(second.get(root)).toEqual(untouched);
        expect(await readFile(path.join(gitDir, "index"))).toEqual(indexBytes);
        expect(await readFile(file)).toEqual(working);
        expect(
            execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: root,
                encoding: "utf8",
                timeout: 10_000,
            }).trim(),
        ).toBe(actualHead);
    });

    it("returns a matching terminal receipt and rejects an unreceipted stale request", async () => {
        const { first, second, persistence, request } = await transactionFixture();
        const lease = await first.acquireTargetOperationLease(root);
        let prepared: ChangelistState;
        try {
            prepared = (await first.prepareTargetOperation(lease, request)).state;
        } finally {
            await lease.release();
        }
        const terminal = {
            ...prepared!,
            revision: prepared!.revision + 1,
            targetOperationReceipts: {
                [operationId]: {
                    ...receipt(operationId, request.evidenceHash),
                    requestHash: prepared!.pendingTargetOperation!.requestHash,
                },
            },
        };
        delete terminal.pendingTargetOperation;
        // Concrete terminal metadata is supplied here; finish belongs to the next transaction slice.
        let release = await persistence.acquire();
        try {
            await persistence.write(terminal);
        } finally {
            await release();
        }
        const recoveryLease = await second.acquireTargetOperationLease(root);
        try {
            expect(await second.prepareTargetOperation(recoveryLease, request)).toEqual({
                status: "known",
                state: terminal,
            });
            await expect(
                second.prepareTargetOperation(recoveryLease, {
                    ...request,
                    sourceDraft: "different",
                }),
            ).rejects.toThrow(/request identity/i);
        } finally {
            await recoveryLease.release();
        }
        delete terminal.targetOperationReceipts;
        terminal.revision++;
        release = await persistence.acquire();
        try {
            await persistence.write(terminal);
        } finally {
            await release();
        }
        const staleLease = await second.acquireTargetOperationLease(root);
        try {
            await expect(second.prepareTargetOperation(staleLease, request)).rejects.toThrow(
                /changed|refresh/i,
            );
            expect(second.get(root)).toEqual(terminal);
        } finally {
            await staleLease.release();
        }
    });

    it("keeps successful entries frozen across partial and conflicted checkpoints", async () => {
        const { first, persistence, before, request } = await transactionFixture();
        const selectedBefore = {
            ...before,
            entries: [
                ...before.entries,
                { changeId: "change-2", path: "src/file.ts", outcome: "pending" as const },
            ],
        };
        const beforeHash = await persistence.storeTargetOperationEvidence(selectedBefore);
        const selectedRequest = {
            ...request,
            evidenceHash: beforeHash,
            shelf: { ...request.shelf!, changeIds: ["change-1", "change-2"] },
        };
        const lease = await first.acquireTargetOperationLease(root);
        try {
            const { state: prepared } = await first.prepareTargetOperation(lease, selectedRequest);
            const partial = {
                ...selectedBefore,
                checkpoint: "after" as const,
                previousEvidenceHash: beforeHash,
                entries: selectedBefore.entries.map((entry, index) => ({
                    ...entry,
                    outcome: index === 0 ? ("applied" as const) : ("pending" as const),
                })),
            };
            const partialHash = await persistence.storeTargetOperationEvidence(partial);
            const expected = {
                id: operationId,
                revision: prepared.revision,
                expectedPhase: "prepared" as const,
                evidenceHash: partialHash,
            };
            await expect(
                first.checkpointTargetOperation(lease, { ...expected, phase: "gitApplied" }),
            ).rejects.toThrow(/progress|evidence/i);
            const progressed = await first.checkpointTargetOperation(lease, {
                ...expected,
                phase: "prepared",
            });
            const conflict = {
                ...partial,
                previousEvidenceHash: partialHash,
                entries: partial.entries.map((entry, index) => ({
                    ...entry,
                    outcome: index === 0 ? ("applied" as const) : ("conflicted" as const),
                })),
            };
            const conflictHash = await persistence.storeTargetOperationEvidence(conflict);
            const conflicted = await first.checkpointTargetOperation(lease, {
                id: operationId,
                revision: progressed.revision,
                expectedPhase: "prepared",
                phase: "conflicted",
                evidenceHash: conflictHash,
            });
            const regression = {
                ...conflict,
                previousEvidenceHash: conflictHash,
                entries: conflict.entries.map((entry, index) => ({
                    ...entry,
                    outcome: index === 0 ? ("pending" as const) : ("conflicted" as const),
                })),
            };
            const regressionHash = await persistence.storeTargetOperationEvidence(regression);
            await expect(
                first.checkpointTargetOperation(lease, {
                    id: operationId,
                    revision: conflicted.revision,
                    expectedPhase: "conflicted",
                    phase: "conflicted",
                    evidenceHash: regressionHash,
                }),
            ).rejects.toThrow(/progress|evidence/i);
            const resolved = {
                ...conflict,
                previousEvidenceHash: conflictHash,
                entries: conflict.entries.map((entry) => ({
                    ...entry,
                    outcome: "applied" as const,
                })),
            };
            const resolvedHash = await persistence.storeTargetOperationEvidence(resolved);
            const applied = await first.checkpointTargetOperation(lease, {
                id: operationId,
                revision: conflicted.revision,
                expectedPhase: "conflicted",
                phase: "gitApplied",
                evidenceHash: resolvedHash,
            });
            expect(applied.pendingTargetOperation?.requestHash).toBe(
                prepared.pendingTargetOperation?.requestHash,
            );
            expect(applied.pendingTargetOperation?.beforeEvidenceHash).toBe(beforeHash);
        } finally {
            await lease.release();
        }
    });

    it.each([false, true])(
        "real Git apply occurs once across reopen with checkpoint=%s",
        async (checkpointed) => {
            execFileSync("git", ["init", "--quiet"], { cwd: root, timeout: 10_000 });
            execFileSync(
                "git",
                [
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--quiet",
                    "--allow-empty",
                    "-m",
                    "base",
                ],
                { cwd: root, timeout: 10_000 },
            );
            const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: root,
                encoding: "utf8",
                timeout: 10_000,
            }).trim();
            const { first, second, persistence, before, request } = await transactionFixture();
            const actualBefore: TargetOperationEvidence = {
                ...before,
                head: actualHead,
                indexFingerprint: changeFingerprint("no affected index entries"),
                paths: [{ path: "created.txt", state: { kind: "absent" } }],
                entries: [{ changeId: "change-1", path: "created.txt", outcome: "pending" }],
            };
            const beforeHash = await persistence.storeTargetOperationEvidence(actualBefore);
            const actualRequest = { ...request, evidenceHash: beforeHash, headBefore: actualHead };
            let mutations = 0;
            const applyOnce = () => {
                mutations++;
                execFileSync("git", ["apply", "-"], {
                    cwd: root,
                    timeout: 10_000,
                    input: "diff --git a/created.txt b/created.txt\nnew file mode 100644\n--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+created once\n",
                });
            };
            const lease = await first.acquireTargetOperationLease(root);
            try {
                const prepared = await first.prepareTargetOperation(lease, actualRequest);
                if (prepared.status === "prepared") applyOnce();
                if (checkpointed) {
                    const bytes = await readFile(path.join(root, "created.txt"));
                    const content = {
                        hash: await persistence.storeTargetOperationObject(bytes),
                        size: bytes.byteLength,
                    };
                    const after: TargetOperationEvidence = {
                        ...actualBefore,
                        checkpoint: "after",
                        previousEvidenceHash: beforeHash,
                        paths: [
                            {
                                path: "created.txt",
                                state: {
                                    kind: "regular",
                                    executable: false,
                                    content,
                                    identity: await pathIdentity(path.join(root, "created.txt")),
                                },
                            },
                        ],
                        entries: [
                            { changeId: "change-1", path: "created.txt", outcome: "applied" },
                        ],
                    };
                    await first.checkpointTargetOperation(lease, {
                        id: operationId,
                        revision: prepared.state.revision,
                        expectedPhase: "prepared",
                        phase: "gitApplied",
                        evidenceHash: await persistence.storeTargetOperationEvidence(after),
                    });
                }
            } finally {
                await lease.release();
            }
            const recoveryLease = await second.acquireTargetOperationLease(root);
            try {
                const retry = await second.prepareTargetOperation(recoveryLease, actualRequest);
                expect(
                    retry.status,
                    "a crash never makes a recorded request executable again",
                ).toBe("known");
                if (retry.status === "prepared") applyOnce();
                if (!checkpointed)
                    await second.markTargetOperationReview(recoveryLease, {
                        id: operationId,
                        revision: retry.state.revision,
                        expectedPhase: "prepared",
                    });
            } finally {
                await recoveryLease.release();
            }
            expect(mutations, "the real Git apply command ran exactly once").toBe(1);
            expect(await readFile(path.join(root, "created.txt"), "utf8")).toBe("created once\n");
            expect(second.get(root).pendingTargetOperation?.phase).toBe(
                checkpointed ? "gitApplied" : "reviewRequired",
            );
            expect(second.get(root).pendingTargetOperation?.sourceDraft).toBe(
                "captured shelf draft",
            );
        },
    );

    it("preserves ownership completion when later evidence requires review", async () => {
        const { first, second } = await fencedStores("ownershipPublished");
        const before = first.get(root);
        const lease = await first.acquireTargetOperationLease(root);
        try {
            const reviewed = await first.markTargetOperationReview(lease, {
                id: operationId,
                revision: before.revision,
                expectedPhase: "ownershipPublished",
            });
            expect(reviewed.pendingTargetOperation).toEqual({
                ...before.pendingTargetOperation,
                phase: "reviewRequired",
            });
        } finally {
            await lease.release();
        }
        expect(second.get(root).pendingTargetOperation?.completion).toEqual(
            before.pendingTargetOperation?.completion,
        );
    });

    it("holds one metadata lease without reentrant acquisition and rejects foreign or released handles", async () => {
        const { first, second, request } = await transactionFixture();
        const acquire = vi.spyOn(ChangelistPersistence.prototype, "acquire");
        const lease = await first.acquireTargetOperationLease(root);
        try {
            expect(acquire).toHaveBeenCalledTimes(1);
            const before = first.get(root);
            await expect(
                first.acquireTargetOperationLease(root),
                "a held local metadata lease reports typed busy without changing state",
            ).rejects.toBeInstanceOf(RepositoryLockBusyError);
            expect(first.get(root)).toEqual(before);
            await expect(second.prepareTargetOperation(lease, request)).rejects.toThrow(/lease/i);
            await expect(first.prepareTargetOperation({ ...lease }, request)).rejects.toThrow(
                /lease/i,
            );
            await expect(first.beginCommit(root)).rejects.toThrow(/operation|lease/i);
            await expect(first.create(root, 0, "Blocked")).rejects.toThrow(/operation|lease/i);
            await first.prepareTargetOperation(lease, request);
            const pending = first.get(root);
            await expect(
                first.consumeCommitted(
                    root,
                    "file.txt",
                    "c".repeat(64),
                    "all",
                    new Set(),
                    new Set(),
                    0,
                    undefined,
                    lease,
                ),
                "selected removal cannot consume metadata while a target operation is pending",
            ).rejects.toThrow(/pending|operation/i);
            expect(first.get(root)).toEqual(pending);
            expect(
                acquire,
                "named transaction methods reuse the held metadata lease",
            ).toHaveBeenCalledTimes(1);
        } finally {
            await lease.release();
        }
        await lease.release();
        await expect(first.prepareTargetOperation(lease, request)).rejects.toThrow(/lease/i);
        const recoveryLease = await second.acquireTargetOperationLease(root);
        await recoveryLease.release();
    });

    it("publishes a new inactive destination and captured intent atomically and returns the same request", async () => {
        const { first, second, request } = await transactionFixture();
        const original = first.get(root);
        const lease = await first.acquireTargetOperationLease(root);
        let prepared: ChangelistState;
        try {
            const preparation = await first.prepareTargetOperation(lease, request);
            expect(
                preparation.status,
                "only a fresh prepared publication authorizes the first Git application",
            ).toBe("prepared");
            prepared = preparation.state;
            expect(prepared.revision).toBe(original.revision + 1);
            expect(prepared.activeId).toBe(original.activeId);
            expect(prepared.lists).toHaveLength(2);
            expect(prepared.pendingTargetOperation).toMatchObject({
                id: operationId,
                phase: "prepared",
                sourceDraft: "captured shelf draft",
                beforeEvidenceHash: request.evidenceHash,
                destinationCreation: { name: "Destination", description: "", draft: "" },
            });
            expect(await first.prepareTargetOperation(lease, request)).toEqual({
                status: "known",
                state: prepared,
            });
            await expect(
                first.prepareTargetOperation(lease, { ...request, sourceDraft: "different" }),
            ).rejects.toThrow(/request/i);
        } finally {
            await lease.release();
        }
        expect(second.get(root)).toEqual(prepared!);
        await expect(second.create(root, second.revision(root), "Blocked")).rejects.toThrow(
            /pending/i,
        );
        const recoveryLease = await second.acquireTargetOperationLease(root);
        try {
            expect(await second.prepareTargetOperation(recoveryLease, request)).toEqual({
                status: "known",
                state: prepared!,
            });
        } finally {
            await recoveryLease.release();
        }
    });

    it("rejects stale target intent, missing evidence, foreign operation evidence and duplicate names without creating a list", async () => {
        const { first, persistence, before, request } = await transactionFixture();
        await first.create(root, first.revision(root), "Reserved");
        // Ordinary metadata GC may collect unreferenced preflight evidence before the lease.
        await persistence.storeTargetOperationObject(Buffer.from("data"));
        await persistence.storeTargetOperationEvidence(before);
        const state = first.get(root);
        const lease = await first.acquireTargetOperationLease(root);
        try {
            await expect(first.prepareTargetOperation(lease, request)).rejects.toThrow(
                /changed|refresh/i,
            );
            const current = {
                ...request,
                target: { kind: "new" as const, name: "Unique", revision: state.revision },
            };
            await expect(
                first.prepareTargetOperation(lease, { ...current, evidenceHash: hash("f") }),
            ).rejects.toBeInstanceOf(ChangelistEvidenceError);
            const foreignHash = await persistence.storeTargetOperationEvidence({
                ...before,
                operationId: receiptId,
            });
            await expect(
                first.prepareTargetOperation(lease, { ...current, evidenceHash: foreignHash }),
            ).rejects.toThrow(/evidence/i);
            await expect(
                first.prepareTargetOperation(lease, {
                    ...current,
                    target: { ...current.target, name: "reserved" },
                }),
            ).rejects.toThrow(/already exists/i);
            expect(first.get(root)).toEqual(state);
        } finally {
            await lease.release();
        }
    });

    it.each(["before", "after"] as const)(
        "reopens safely after a %s-prepare-publication failure",
        async (failure) => {
            const { first, second, request } = await transactionFixture();
            const original = ChangelistPersistence.prototype.write;
            const write = vi
                .spyOn(ChangelistPersistence.prototype, "write")
                .mockImplementationOnce(async function (state) {
                    if (failure === "after") await original.call(this, state);
                    throw new Error("injected prepare publication failure");
                });
            const lease = await first.acquireTargetOperationLease(root);
            try {
                await expect(first.prepareTargetOperation(lease, request)).rejects.toThrow(
                    /injected/,
                );
            } finally {
                await lease.release();
                write.mockRestore();
            }
            const reopened = second.get(root);
            expect(reopened.lists).toHaveLength(failure === "after" ? 2 : 1);
            expect(!!reopened.pendingTargetOperation).toBe(failure === "after");
            const recoveryLease = await second.acquireTargetOperationLease(root);
            try {
                const retried = await second.prepareTargetOperation(recoveryLease, request);
                expect(retried.status).toBe(failure === "after" ? "known" : "prepared");
                expect(retried.state.lists).toHaveLength(2);
                expect(retried.state.revision).toBe(1);
            } finally {
                await recoveryLease.release();
            }
        },
    );

    it("checkpoints exact affected evidence with phase, identity and revision compare-and-swap", async () => {
        const { first, second, persistence, before, request } = await transactionFixture();
        const lease = await first.acquireTargetOperationLease(root);
        try {
            const { state: prepared } = await first.prepareTargetOperation(lease, request);
            const after = {
                ...before,
                checkpoint: "after" as const,
                previousEvidenceHash: request.evidenceHash,
                entries: before.entries.map((entry) => ({ ...entry, outcome: "applied" as const })),
            };
            const evidenceHash = await persistence.storeTargetOperationEvidence(after);
            const checkpoint = {
                id: operationId,
                revision: prepared.revision,
                expectedPhase: "prepared" as const,
                phase: "gitApplied" as const,
                evidenceHash,
            };
            await expect(
                first.checkpointTargetOperation(lease, { ...checkpoint, revision: 0 }),
            ).rejects.toThrow(/changed|refresh/i);
            await expect(
                first.checkpointTargetOperation(lease, { ...checkpoint, id: receiptId }),
            ).rejects.toThrow(/identity/i);
            await expect(
                first.checkpointTargetOperation(lease, {
                    ...checkpoint,
                    expectedPhase: "conflicted",
                }),
            ).rejects.toThrow(/phase/i);
            const detached = await persistence.storeTargetOperationEvidence({
                ...after,
                previousEvidenceHash: undefined,
            });
            await expect(
                first.checkpointTargetOperation(lease, { ...checkpoint, evidenceHash: detached }),
            ).rejects.toThrow(/evidence/i);
            const unrelated = await persistence.storeTargetOperationEvidence({
                ...after,
                paths: [...after.paths, { path: "unrelated", state: { kind: "absent" } }],
            });
            await expect(
                first.checkpointTargetOperation(lease, { ...checkpoint, evidenceHash: unrelated }),
            ).rejects.toThrow(/affected|evidence/i);
            const applied = await first.checkpointTargetOperation(lease, checkpoint);
            expect(applied.pendingTargetOperation).toMatchObject({
                phase: "gitApplied",
                evidenceHash,
                beforeEvidenceHash: request.evidenceHash,
                requestHash: prepared.pendingTargetOperation!.requestHash,
                sourceDraft: "captured shelf draft",
            });
            await expect(
                first.checkpointTargetOperation(lease, {
                    ...checkpoint,
                    revision: applied.revision,
                    expectedPhase: "gitApplied",
                    phase: "prepared",
                }),
            ).rejects.toThrow(/phase/i);
            expect(await first.prepareTargetOperation(lease, request)).toEqual({
                status: "known",
                state: applied,
            });
        } finally {
            await lease.release();
        }
        expect(second.get(root).pendingTargetOperation?.phase).toBe("gitApplied");
    });

    it("retains the prepared fence and captured intent when uncertainty is marked for review", async () => {
        const { first, second, request } = await transactionFixture();
        const lease = await first.acquireTargetOperationLease(root);
        try {
            const { state: prepared } = await first.prepareTargetOperation(lease, request);
            const reviewed = await first.markTargetOperationReview(lease, {
                id: operationId,
                revision: prepared.revision,
                expectedPhase: "prepared",
            });
            expect(reviewed.pendingTargetOperation).toEqual({
                ...prepared.pendingTargetOperation,
                phase: "reviewRequired",
            });
            expect(await first.prepareTargetOperation(lease, request)).toEqual({
                status: "known",
                state: reviewed,
            });
        } finally {
            await lease.release();
        }
        expect(second.get(root).pendingTargetOperation?.phase).toBe("reviewRequired");
    });
});

/** Publishes a durable fence after a second window has cached the previous revision. */
async function fencedStores(phase: "prepared" | "ownershipPublished" | "shelfPublished") {
    const first = new ChangelistStore();
    const second = new ChangelistStore();
    await first.connect(root, gitDir);
    await first.reconcileFiles(root, ["late.ts"]);
    await first.saveDraft(root, "default", "", "original draft");
    await second.connect(root, gitDir);
    const persistence = await ChangelistPersistence.open(root, gitDir);
    const contentHash = await persistence.storeTargetOperationObject(Buffer.from("data"));
    const evidenceHash = await persistence.storeTargetOperationEvidence(
        evidence(operationId, contentHash),
    );
    const state = first.get(root);
    const pending: TargetOperationRecord = {
        ...record(evidenceHash),
        destinationId: "default",
        phase,
        ...(phase === "prepared"
            ? {}
            : {
                  headAfter: head,
                  completion: {
                      appliedChangeIds: ["change-1"],
                      ownershipRevision: state.revision + 1,
                      draft: "copied" as const,
                      shelfPublication:
                          phase === "shelfPublished"
                              ? ("published" as const)
                              : ("pending" as const),
                      ...(phase === "shelfPublished"
                          ? { publishedGeneration: 3, publishedChecksum: hash("e") }
                          : {}),
                  },
              }),
    };
    const release = await persistence.acquire();
    try {
        await persistence.write({
            ...state,
            revision: state.revision + 1,
            pendingTargetOperation: pending,
        });
    } finally {
        await release();
    }
    return { first, second, persistence };
}

describe("target operation store replay fence", () => {
    const mutations: [string, (store: ChangelistStore) => Promise<unknown>][] = [
        ["create", (store) => store.create(root, store.revision(root), "late list")],
        ["activate", (store) => store.activate(root, store.revision(root), "default")],
        [
            "membership",
            (store) => store.moveFiles(root, store.revision(root), "default", ["late.ts"]),
        ],
        [
            "selection",
            (store) => store.recordSelection(root, "late.ts", "snapshot", "default", [], 1),
        ],
        ["observer reconcile", (store) => store.reconcileFiles(root, ["late.ts"])],
        ["observer review", (store) => store.requireReview(root, "late.ts", true)],
        [
            "commit draft cleanup",
            (store) => store.clearCommittedDraft(root, "default", "original draft"),
        ],
    ];

    it.each(mutations)("second window cannot bypass pending through %s", async (_name, mutate) => {
        const { second, persistence } = await fencedStores("prepared");
        const before = await readFile(persistence.filename, "utf8");
        await expect(mutate(second)).rejects.toThrow("targeted operation");
        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        expect(reopened.get(root).pendingTargetOperation?.id).toBe(operationId);
        expect(await readFile(persistence.filename, "utf8")).toBe(before);
    });

    it("second window cannot begin a selected commit while an operation is pending", async () => {
        const { second, persistence } = await fencedStores("prepared");
        const before = await readFile(persistence.filename, "utf8");
        let releaseCommit: (() => Promise<void>) | undefined;
        try {
            await expect(
                second.beginCommit(root).then((release) => {
                    releaseCommit = release;
                    return release;
                }),
            ).rejects.toThrow("targeted operation");
        } finally {
            await releaseCommit?.();
        }
        const release = await persistence.acquire();
        await release();
        expect(second.isCommitting(root)).toBe(false);
        expect(await readFile(persistence.filename, "utf8")).toBe(before);
    });

    it("stale target pick creates nothing after another window publishes pending", async () => {
        const { second, persistence } = await fencedStores("prepared");
        const before = await readFile(persistence.filename, "utf8");
        await expect(
            second.create(root, second.revision(root) - 1, "stale target"),
        ).rejects.toThrow("Changelists changed");
        expect(await readFile(persistence.filename, "utf8")).toBe(before);
    });

    it("draft edit before ownership publication cannot alter the captured intent", async () => {
        const { second, persistence } = await fencedStores("prepared");
        const before = await readFile(persistence.filename, "utf8");
        await expect(
            second.saveDraft(root, "default", "original draft", "too early"),
        ).rejects.toThrow("targeted operation");
        expect(await readFile(persistence.filename, "utf8")).toBe(before);
    });

    it.each(["ownershipPublished", "shelfPublished"] as const)(
        "guarded draft edit after %s survives reopen without permitting other writes",
        async (phase) => {
            const { first, second, persistence } = await fencedStores(phase);
            const pending = second.get(root).pendingTargetOperation;
            await expect(
                second.saveDraft(root, "default", "original draft", "fresh user draft"),
            ).resolves.toMatchObject({
                lists: expect.arrayContaining([
                    { id: "default", name: "Changes", description: "", draft: "fresh user draft" },
                ]),
            });
            await expect(
                first.saveDraft(root, "default", "original draft", "stale draft"),
            ).rejects.toThrow("commit draft changed");
            await expect(
                first.saveDraft(root, "default", undefined, "unguarded draft"),
            ).rejects.toThrow("targeted operation");
            const before = await readFile(persistence.filename, "utf8");
            for (const [, mutate] of mutations)
                await expect(mutate(first)).rejects.toThrow("targeted operation");
            const reopened = new ChangelistStore();
            await reopened.connect(root, gitDir);
            expect(reopened.draft(root, "default")).toBe("fresh user draft");
            expect(reopened.get(root).pendingTargetOperation).toEqual(pending);
            expect(await readFile(persistence.filename, "utf8")).toBe(before);
        },
    );
});

describe("durable target operation foundation", () => {
    it("pins the offline schema 4 client fixture to the accepted baseline", () => {
        expect(baselineManifest).toEqual({
            fixtureVersion: 1,
            originRevision: baselineRevision,
            entrypoint: "src/changes/changelistStore.ts",
            bundle: "changelistStore.cjs",
            bundleSha256: baselineBundleChecksum,
        });
    });
    it("round-trips pending and terminal records while exposing only a compact summary", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const contentHash = await persistence.storeTargetOperationObject(Buffer.from("data"));
        const evidenceHash = await persistence.storeTargetOperationEvidence(
            evidence(operationId, contentHash),
        );
        const pending: ChangelistState = {
            ...new ChangelistStore().get(root),
            pendingTargetOperation: record(evidenceHash),
        };
        await persistence.write(pending);

        const reopened = new ChangelistStore();
        await reopened.connect(root, gitDir);
        expect(reopened.get(root).pendingTargetOperation).toEqual(pending.pendingTargetOperation);
        expect(reopened.view(root)).toMatchObject({
            targetOperationSummary: {
                id: operationId,
                kind: "shelfRestore",
                phase: "prepared",
                destinationId,
            },
        });
        expect(reopened.view(root)).not.toHaveProperty("pendingTargetOperation");

        const terminal: ChangelistState = {
            ...pending,
            pendingTargetOperation: undefined,
            targetOperationReceipts: { [operationId]: receipt(operationId, evidenceHash) },
        };
        await persistence.write(terminal);
        const terminalReopen = new ChangelistStore();
        await terminalReopen.connect(root, gitDir);
        expect(terminalReopen.get(root).targetOperationReceipts).toEqual(
            terminal.targetOperationReceipts,
        );
        expect(terminalReopen.view(root)).not.toHaveProperty("targetOperationReceipts");
    });

    it("rejects contradictory persisted phases without changing their bytes", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const contentHash = await persistence.storeTargetOperationObject(Buffer.from("data"));
        const evidenceHash = await persistence.storeTargetOperationEvidence(
            evidence(operationId, contentHash),
        );
        await persistence.write({
            ...new ChangelistStore().get(root),
            pendingTargetOperation: record(evidenceHash),
        });
        const saved = JSON.parse(await readFile(persistence.filename, "utf8"));
        saved.state.pendingTargetOperation.phase = "ownershipPublished";
        const malformed = JSON.stringify(saved);
        await writeFile(persistence.filename, malformed);

        await expect(new ChangelistStore().connect(root, gitDir)).rejects.toThrow(
            "requires review",
        );
        expect(await readFile(persistence.filename, "utf8")).toBe(malformed);
    });

    it("retains current pending and terminal evidence roots while collecting unreachable objects", async () => {
        execFileSync("git", ["init", "-q"], { cwd: root });
        gitDir = await realpath(path.join(root, ".git"));
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const contentHash = await persistence.storeTargetOperationObject(Buffer.from("data"));
        const indexHash = await persistence.storeTargetOperationObject(Buffer.from("index"));
        const pendingCheckpoint: TargetOperationEvidence = {
            ...evidence(operationId, contentHash),
            index: [
                {
                    path: "src/file.ts",
                    stage: 0,
                    mode: "100644",
                    oid: gitObjectOid(Buffer.from("index"), "blob"),
                    object: { hash: indexHash, size: 5 },
                    assumeUnchanged: false,
                    skipWorktree: false,
                    intentToAdd: false,
                },
            ],
        };
        const pendingEvidence = await persistence.storeTargetOperationEvidence(pendingCheckpoint);
        const receiptEvidence = await persistence.storeTargetOperationEvidence(
            evidence(receiptId, contentHash),
        );
        const orphanHash = await persistence.storeTargetOperationObject(Buffer.from("lost"));
        const state: ChangelistState = {
            ...new ChangelistStore().get(root),
            pendingTargetOperation: record(pendingEvidence),
            targetOperationReceipts: { [receiptId]: receipt(receiptId, receiptEvidence) },
        };
        await persistence.write(state);
        await persistence.collect(undefined, state);

        const names = await readdir(persistence.evidenceDirectory);
        expect(names).toEqual(
            expect.arrayContaining([
                `${contentHash}.bin`,
                `${indexHash}.bin`,
                `${pendingEvidence}.operation.json`,
                `${receiptEvidence}.operation.json`,
            ]),
        );
        expect(names).not.toContain(`${orphanHash}.bin`);
    });

    it("validates every declared size when operation references share one hash", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const contentHash = await persistence.storeTargetOperationObject(Buffer.from("data"));
        const before = evidence(operationId, contentHash);
        const checkpoint: TargetOperationEvidence = {
            ...before,
            paths: [
                ...before.paths,
                {
                    path: "src/second.ts",
                    state: {
                        kind: "regular",
                        executable: false,
                        content: { hash: contentHash, size: 5 },
                        identity: {
                            device: "1",
                            inode: "3",
                            size: 5,
                            modifiedNs: "4",
                            changedNs: "5",
                        },
                    },
                },
            ],
        };
        await expect(persistence.storeTargetOperationEvidence(checkpoint)).rejects.toThrow(
            "requires review",
        );
    });

    it("accepts real rename and reinstall identities while preserving bytes and modes", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const currentBytes = Buffer.from("current bytes");
        const desiredBytes = Buffer.from("before bytes");
        const currentHash = await persistence.storeTargetOperationObject(currentBytes);
        const desiredHash = await persistence.storeTargetOperationObject(desiredBytes);
        const filename = path.join(root, "src/file.ts");
        const desiredSeed = path.join(root, "desired-seed");
        const recoveryPath = `.intelligit-recovery/${operationId}/src-file.ts`;
        const recoveryFilename = path.join(root, recoveryPath);
        await mkdir(path.dirname(filename), { recursive: true });
        await mkdir(path.dirname(recoveryFilename), { recursive: true });
        await writeFile(filename, currentBytes);
        await chmod(filename, 0o755);
        await writeFile(desiredSeed, desiredBytes);
        await chmod(desiredSeed, 0o644);
        const expectedCurrent = {
            kind: "regular" as const,
            executable: true,
            content: { hash: currentHash, size: currentBytes.byteLength },
            identity: await pathIdentity(filename),
        };
        const desiredBefore = {
            kind: "regular" as const,
            executable: false,
            content: { hash: desiredHash, size: desiredBytes.byteLength },
            identity: await pathIdentity(desiredSeed),
        };

        await rename(filename, recoveryFilename);
        const moved = { ...expectedCurrent, identity: await pathIdentity(recoveryFilename) };
        await writeFile(filename, desiredBytes);
        await chmod(filename, 0o644);
        const installed = { ...desiredBefore, identity: await pathIdentity(filename) };
        expect(moved.identity.inode, "same-filesystem rename retains the inode").toBe(
            expectedCurrent.identity.inode,
        );
        expect(installed.identity.inode, "reinstall records its new inode").not.toBe(
            desiredBefore.identity.inode,
        );
        expect(await readFile(recoveryFilename)).toEqual(currentBytes);
        expect(await readFile(filename)).toEqual(desiredBytes);
        expect(Number((await lstat(recoveryFilename)).mode & 0o111)).not.toBe(0);
        expect(Number((await lstat(filename)).mode & 0o111)).toBe(0);

        const checkpoint: TargetOperationEvidence = {
            ...evidence(operationId, currentHash, currentBytes.byteLength),
            checkpoint: "abortPathsRestored",
            paths: [{ path: "src/file.ts", state: expectedCurrent }],
            abortPaths: [
                {
                    path: "src/file.ts",
                    recoveryPath,
                    expectedCurrent,
                    desiredBefore,
                    move: { state: "moved", observed: moved },
                    install: { state: "installed", observed: installed },
                },
            ],
        };
        expect(parseTargetOperationEvidence(checkpoint, root, gitDir)).toEqual(checkpoint);
        expect(
            parseTargetOperationEvidence(
                {
                    ...checkpoint,
                    abortPaths: [
                        {
                            ...checkpoint.abortPaths![0],
                            move: {
                                state: "moved",
                                observed: {
                                    ...moved,
                                    identity: {
                                        ...moved.identity,
                                        inode: String(BigInt(moved.identity.inode) + 1n),
                                    },
                                },
                            },
                        },
                    ],
                },
                root,
                gitDir,
            ),
            "a move cannot substitute a different inode",
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                {
                    ...checkpoint,
                    abortPaths: [
                        {
                            ...checkpoint.abortPaths![0],
                            move: {
                                state: "moved",
                                observed: { ...moved, content: desiredBefore.content },
                            },
                        },
                    ],
                },
                root,
                gitDir,
            ),
            "a move cannot substitute different bytes",
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                {
                    ...checkpoint,
                    abortPaths: [
                        {
                            ...checkpoint.abortPaths![0],
                            move: {
                                state: "moved",
                                observed: { ...moved, executable: false },
                            },
                        },
                    ],
                },
                root,
                gitDir,
            ),
            "a move cannot substitute a different mode",
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                {
                    ...checkpoint,
                    abortPaths: [
                        {
                            ...checkpoint.abortPaths![0],
                            install: {
                                state: "installed",
                                observed: { ...installed, executable: true },
                            },
                        },
                    ],
                },
                root,
                gitDir,
            ),
            "an install cannot substitute a different mode",
        ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                {
                    ...checkpoint,
                    abortPaths: [
                        {
                            ...checkpoint.abortPaths![0],
                            install: {
                                state: "installed",
                                observed: { ...installed, content: expectedCurrent.content },
                            },
                        },
                    ],
                },
                root,
                gitDir,
            ),
            "an install cannot substitute different bytes",
        ).toBeUndefined();
    });

    it("keeps warm metadata writes payload-free but validates a newly referenced chain", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const content = Buffer.alloc(4 * 1024 * 1024, 7);
        const contentHash = await persistence.storeTargetOperationObject(content);
        const evidenceHash = await persistence.storeTargetOperationEvidence(
            evidence(receiptId, contentHash, content.byteLength),
        );
        await persistence.write({
            ...new ChangelistStore().get(root),
            targetOperationReceipts: { [receiptId]: receipt(receiptId, evidenceHash) },
        });
        const store = new ChangelistStore();
        await store.connect(root, gitDir);

        const gitRuns = vi.spyOn(GitExecutor.prototype, "runBinary");
        let payloadOpens = 0;
        const openFile = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            if (String(args[0]).endsWith(".bin")) payloadOpens++;
            return openFile(...args);
        });
        await store.saveDraft(root, "all", "", "metadata only");
        expect(payloadOpens, "an unchanged retained receipt must not reread recovery bytes").toBe(
            0,
        );
        expect(
            gitRuns,
            "evidence without index entries does not query the object format",
        ).not.toHaveBeenCalled();

        const newHash = await persistence.storeTargetOperationObject(Buffer.from("next"));
        const newEvidenceHash = await persistence.storeTargetOperationEvidence(
            evidence(operationId, newHash),
        );
        await writeFile(path.join(persistence.evidenceDirectory, `${newHash}.bin`), "bad");
        await expect(
            persistence.write({
                ...store.get(root),
                pendingTargetOperation: record(newEvidenceHash),
            }),
            "a changed root is validated before publication",
        ).rejects.toThrow("requires review");
    });

    it("invalidates cached operation evidence on replacement and after failed validation", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const content = Buffer.from("data");
        const contentHash = await persistence.storeTargetOperationObject(content);
        const evidenceHash = await persistence.storeTargetOperationEvidence(
            evidence(receiptId, contentHash),
        );
        const state: ChangelistState = {
            ...new ChangelistStore().get(root),
            targetOperationReceipts: { [receiptId]: receipt(receiptId, evidenceHash) },
        };
        await persistence.write(state);
        const filename = path.join(persistence.evidenceDirectory, `${contentHash}.bin`);
        const replacement = `${filename}.replacement`;
        await writeFile(replacement, content);
        await rename(replacement, filename);

        let payloadOpens = 0;
        const openFile = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            if (String(args[0]).endsWith(".bin")) payloadOpens++;
            return openFile(...args);
        });
        await persistence.write({ ...state, allDraft: "identity changed" });
        expect(payloadOpens, "a replaced object is revalidated once").toBe(1);
        payloadOpens = 0;
        await persistence.write({ ...state, allDraft: "identity stable" });
        expect(payloadOpens, "an unchanged validated object is not reread").toBe(0);

        await writeFile(filename, "evil");
        await expect(persistence.validateEvidence(state)).rejects.toThrow("requires review");
        await expect(
            persistence.write({ ...state, allDraft: "must remain rejected" }),
            "failed forced validation cannot leave a reusable cached success",
        ).rejects.toThrow("requires review");
    });

    it("binds saved index bytes to real SHA-1 Git object identifiers and types", async () => {
        execFileSync("git", ["init", "-q"], { cwd: root });
        gitDir = await realpath(path.join(root, ".git"));
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const contents = Buffer.from("indexed bytes\n");
        const objectHash = await persistence.storeTargetOperationObject(contents);
        const oid = execFileSync("git", ["hash-object", "--stdin"], {
            cwd: root,
            input: contents,
            encoding: "utf8",
        }).trim();
        expect(oid).toBe(gitObjectOid(contents, "blob"));
        const checkpoint: TargetOperationEvidence = {
            ...evidence(operationId, objectHash, contents.byteLength),
            index: [
                {
                    path: "src/file.ts",
                    stage: 0,
                    mode: "100644",
                    oid,
                    object: { hash: objectHash, size: contents.byteLength },
                    assumeUnchanged: false,
                    skipWorktree: false,
                    intentToAdd: false,
                },
            ],
        };
        await expect(persistence.storeTargetOperationEvidence(checkpoint)).resolves.toMatch(
            /^[a-f0-9]{64}$/,
        );
        await expect(
            persistence.storeTargetOperationEvidence({
                ...checkpoint,
                index: [{ ...checkpoint.index[0], oid: "1".repeat(40) }],
            }),
            "declared OID must hash the saved bytes",
        ).rejects.toThrow("requires review");
        await expect(
            persistence.storeTargetOperationEvidence({
                ...checkpoint,
                index: [{ ...checkpoint.index[0], mode: "160000" }],
            }),
            "gitlink entries require commit object bytes",
        ).rejects.toThrow("requires review");
        await expect(
            persistence.storeTargetOperationEvidence({
                ...checkpoint,
                index: [
                    {
                        ...checkpoint.index[0],
                        oid: gitObjectOid(contents, "blob", "sha256"),
                    },
                ],
            }),
            "a SHA-1 repository cannot claim a SHA-256 object ID",
        ).rejects.toThrow("requires review");
    });

    it("binds saved index bytes to real SHA-256 Git object identifiers", async (context) => {
        try {
            execFileSync("git", ["init", "-q", "--object-format=sha256"], { cwd: root });
        } catch {
            context.skip();
            return;
        }
        gitDir = await realpath(path.join(root, ".git"));
        const configFilename = path.join(gitDir, "config");
        const includeFilename = path.join(gitDir, "object-format.inc");
        const config = await readFile(configFilename, "utf8");
        expect(config).toMatch(/^\s*objectformat\s*=\s*sha256\s*$/im);
        await writeFile(
            configFilename,
            `${config.replace(
                /^\s*objectformat\s*=\s*sha256\s*$/im,
                '\tobjectformat = "sha256"',
            )}\n[include]\n\tpath = object-format.inc\n`,
        );
        await writeFile(includeFilename, "[core]\n\tbare = false\n");
        expect(
            execFileSync("git", ["rev-parse", "--show-object-format"], {
                cwd: root,
                encoding: "utf8",
            }).trim(),
        ).toBe("sha256");
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const contents = Buffer.from("sha256 indexed bytes\n");
        const objectHash = await persistence.storeTargetOperationObject(contents);
        const oid = execFileSync("git", ["hash-object", "--stdin"], {
            cwd: root,
            input: contents,
            encoding: "utf8",
        }).trim();
        expect(oid).toHaveLength(64);
        expect(oid).toBe(gitObjectOid(contents, "blob", "sha256"));
        await expect(
            persistence.storeTargetOperationEvidence({
                ...evidence(operationId, objectHash, contents.byteLength),
                index: [
                    {
                        path: "src/file.ts",
                        stage: 0,
                        mode: "100644",
                        oid,
                        object: { hash: objectHash, size: contents.byteLength },
                        assumeUnchanged: false,
                        skipWorktree: false,
                        intentToAdd: false,
                    },
                ],
            }),
        ).resolves.toMatch(/^[a-f0-9]{64}$/);
        await expect(
            persistence.storeTargetOperationEvidence({
                ...evidence(operationId, objectHash, contents.byteLength),
                index: [
                    {
                        path: "src/file.ts",
                        stage: 0,
                        mode: "100644",
                        oid: gitObjectOid(contents, "blob", "sha1"),
                        object: { hash: objectHash, size: contents.byteLength },
                        assumeUnchanged: false,
                        skipWorktree: false,
                        intentToAdd: false,
                    },
                ],
            }),
            "a SHA-256 repository cannot claim a SHA-1 object ID",
        ).rejects.toThrow("requires review");
    });

    it.each(["", "sha512\n"])(
        "rejects an unknown object format lookup result %j",
        async (reportedFormat) => {
            execFileSync("git", ["init", "-q"], { cwd: root });
            gitDir = await realpath(path.join(root, ".git"));
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const contents = Buffer.from("indexed bytes\n");
            const objectHash = await persistence.storeTargetOperationObject(contents);
            const run = vi.spyOn(GitExecutor.prototype, "runBinary").mockResolvedValueOnce({
                stdout: Buffer.from(reportedFormat),
                stderr: Buffer.alloc(0),
                exitCode: 0,
                truncated: false,
            });

            await expect(
                persistence.storeTargetOperationEvidence({
                    ...evidence(operationId, objectHash, contents.byteLength),
                    index: [
                        {
                            path: "src/file.ts",
                            stage: 0,
                            mode: "100644",
                            oid: gitObjectOid(contents, "blob"),
                            object: { hash: objectHash, size: contents.byteLength },
                            assumeUnchanged: false,
                            skipWorktree: false,
                            intentToAdd: false,
                        },
                    ],
                }),
            ).rejects.toThrow("requires review");
            expect(run).toHaveBeenCalledWith(["rev-parse", "--show-object-format"], {
                maxOutputBytes: 16,
            });
        },
    );

    it("rejects index evidence when Git cannot discover an object format", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const contents = Buffer.from("indexed bytes\n");
        const objectHash = await persistence.storeTargetOperationObject(contents);

        await expect(
            persistence.storeTargetOperationEvidence({
                ...evidence(operationId, objectHash, contents.byteLength),
                index: [
                    {
                        path: "src/file.ts",
                        stage: 0,
                        mode: "100644",
                        oid: gitObjectOid(contents, "blob"),
                        object: { hash: objectHash, size: contents.byteLength },
                        assumeUnchanged: false,
                        skipWorktree: false,
                        intentToAdd: false,
                    },
                ],
            }),
        ).rejects.toThrow("requires review");
    });

    it.each(["checkpoint", "object", "index object"] as const)(
        "rejects corrupt operation %s bytes without changing authoritative metadata",
        async (corrupt) => {
            if (corrupt === "index object") {
                execFileSync("git", ["init", "-q"], { cwd: root });
                gitDir = await realpath(path.join(root, ".git"));
            }
            const persistence = await ChangelistPersistence.open(root, gitDir);
            const contentHash = await persistence.storeTargetOperationObject(Buffer.from("data"));
            const indexHash =
                corrupt === "index object"
                    ? await persistence.storeTargetOperationObject(Buffer.from("index"))
                    : undefined;
            const beforeEvidence = evidence(operationId, contentHash);
            const checkpoint: TargetOperationEvidence = indexHash
                ? {
                      ...beforeEvidence,
                      index: [
                          {
                              path: "src/file.ts",
                              stage: 0,
                              mode: "100644",
                              oid: gitObjectOid(Buffer.from("index"), "blob"),
                              object: { hash: indexHash, size: 5 },
                              assumeUnchanged: false,
                              skipWorktree: false,
                              intentToAdd: false,
                          },
                      ],
                  }
                : beforeEvidence;
            const evidenceHash = await persistence.storeTargetOperationEvidence(checkpoint);
            await persistence.write({
                ...new ChangelistStore().get(root),
                pendingTargetOperation: record(evidenceHash),
            });
            const before = await readFile(persistence.filename, "utf8");
            const corruptPath = path.join(
                persistence.evidenceDirectory,
                corrupt === "checkpoint"
                    ? `${evidenceHash}.operation.json`
                    : `${corrupt === "index object" ? indexHash : contentHash}.bin`,
            );
            if (corrupt === "checkpoint") {
                const checkpoint = JSON.parse(await readFile(corruptPath, "utf8"));
                checkpoint.indexFingerprint = hash("f");
                await writeFile(corruptPath, JSON.stringify(checkpoint));
            } else await writeFile(corruptPath, "corrupt");

            await expect(new ChangelistStore().connect(root, gitDir)).rejects.toThrow(
                "requires review",
            );
            expect(await readFile(persistence.filename, "utf8")).toBe(before);
        },
    );

    it("upgrades schema 4 exactly once without rewriting range sidecars", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const snapshot: RangeSnapshot = {
            contentId: hash("1"),
            baseHash: hash("2"),
            workingHash: hash("3"),
            head,
            indexHash: hash("4"),
            baseLines: [],
            workingLines: [],
            anchors: [],
        };
        const reference = await persistence.storeSnapshot("src/file.ts", snapshot);
        const state: ChangelistState = {
            ...new ChangelistStore().get(root),
            allDraft: "schema four draft",
            changes: {
                "src/file.ts": { contentId: snapshot.contentId, lines: {}, tracking: reference },
            },
        };
        const schema4 = JSON.stringify({ schemaVersion: 4, root, gitDir, state });
        await writeFile(persistence.filename, schema4);
        const sidecar = path.join(persistence.evidenceDirectory, `${reference.blob}.json`);
        const beforeBytes = await readFile(sidecar);
        const beforeStat = await stat(sidecar);

        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        expect(store.get(root)).toEqual(state);
        expect(JSON.parse(await readFile(persistence.filename, "utf8")).schemaVersion).toBe(5);
        expect(
            await readFile(
                path.join(
                    persistence.directory,
                    `state-v4.${changeFingerprint(schema4)}.backup.json`,
                ),
                "utf8",
            ),
        ).toBe(schema4);
        expect(await readFile(sidecar)).toEqual(beforeBytes);
        expect((await stat(sidecar)).ino).toBe(beforeStat.ino);
    });

    it("resumes an interrupted schema 4 upgrade with an equivalent hydrated workspace seed", async () => {
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const snapshot: RangeSnapshot = {
            contentId: hash("1"),
            baseHash: hash("2"),
            workingHash: hash("3"),
            head,
            indexHash: hash("4"),
            baseLines: [hash("5")],
            workingLines: [hash("6")],
            anchors: [],
        };
        const reference = await persistence.storeSnapshot("src/file.ts", snapshot);
        const compact: ChangelistState = {
            ...new ChangelistStore().get(root),
            revision: 4,
            allDraft: "schema four draft",
            changes: {
                "src/file.ts": { contentId: snapshot.contentId, lines: {}, tracking: reference },
            },
        };
        const hydrated = {
            ...compact,
            changes: {
                "src/file.ts": { contentId: snapshot.contentId, lines: {}, tracking: snapshot },
            },
        };
        const schema4 = JSON.stringify({ schemaVersion: 4, root, gitDir, state: compact });
        await writeFile(persistence.filename, schema4);
        const values = new Map<string, unknown>([
            [
                "intelligit.changelists.v1",
                { schemaVersion: 4, entries: [{ root, state: hydrated }] },
            ],
        ]);
        const storage = {
            get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
            update: async (key: string, value: unknown) => {
                values.set(key, structuredClone(value));
            },
        };
        const interrupted = vi
            .spyOn(ChangelistPersistence.prototype, "write")
            .mockRejectedValueOnce(new Error("interrupt schema 4 publication"));
        await expect(new ChangelistStore(storage).connect(root, gitDir)).rejects.toThrow(
            "interrupt schema 4 publication",
        );
        interrupted.mockRestore();
        expect(await readFile(persistence.filename, "utf8")).toBe(schema4);

        const reopened = new ChangelistStore(storage);
        await reopened.connect(root, gitDir);
        expect(reopened.get(root)).toEqual(compact);
        expect(JSON.parse(await readFile(persistence.filename, "utf8")).schemaVersion).toBe(5);
        expect(
            await readFile(
                path.join(
                    persistence.directory,
                    `state-v4.${changeFingerprint(schema4)}.backup.json`,
                ),
                "utf8",
            ),
        ).toBe(schema4);
    });

    it("makes the exact schema 4 client refuse schema 5 authority and workspace sentinel without writes", async () => {
        const current = new ChangelistStore();
        await current.connect(root, gitDir);
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const authoritativeBefore = await readFile(persistence.filename, "utf8");
        await expect(new BaselineChangelistStore().connect(root, gitDir)).rejects.toThrow();
        expect(await readFile(persistence.filename, "utf8")).toBe(authoritativeBefore);

        const values = new Map<string, unknown>();
        const writes: string[] = [];
        const storage = {
            get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
            update: async (key: string, value: unknown) => {
                writes.push(key);
                values.set(key, structuredClone(value));
            },
        };
        const writer = new ChangelistStore(storage);
        await writer.connect(root, gitDir);
        expect(values.get("intelligit.changelists.v1")).toMatchObject({ schemaVersion: 5 });
        writes.length = 0;
        const oldClient = new BaselineChangelistStore(storage);
        expect(() => oldClient.get(root)).toThrow("will not be overwritten");
        await expect(oldClient.create(root, 0, "unsafe old write")).rejects.toThrow(
            "will not be overwritten",
        );
        expect(writes).toEqual([]);
        expect(await readFile(persistence.filename, "utf8")).toBe(authoritativeBefore);
    });
});
