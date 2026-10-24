import { execFileSync } from "node:child_process";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";
import { ChangelistStore, targetPathUnowned } from "../../../src/changes/changelistStore";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { changeFingerprint } from "../../../src/changes/parseDiff";
import {
    parseTargetOperationEvidence,
    type TargetOperationEvidence,
    type TargetPathState,
} from "../../../src/changes/targetOperation";

const operationId = "00000000-0000-4000-8000-000000000001";
const file = "src/file.ts";
const roots: string[] = [];
afterEach(async () => {
    await removeScratchDirectories(...roots.splice(0));
});

/** Real repository observations are captured before mutation, never reconstructed during recovery. */
async function structuralFixture(
    scenario = "tracked",
    alterBefore?: (before: TargetOperationEvidence) => TargetOperationEvidence,
) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "target-structural-")));
    roots.push(root);
    const gitDir = path.join(root, ".git");
    const git = (args: string[], input?: string) =>
        execFileSync("git", args, { cwd: root, input, timeout: 10_000 });
    git(["init", "-q"]);
    await mkdir(path.join(root, "src"));
    const link = scenario.startsWith("symlink");
    const sourcePath = scenario.startsWith("rename") ? "src/source.ts" : undefined;
    const initialFile = sourcePath ?? file;
    const affected = sourcePath ? [file, sourcePath] : [file];
    if (!["absent", "intent", "staged addition"].includes(scenario)) {
        if (link) await symlink("base-target", path.join(root, file));
        else await writeFile(path.join(root, initialFile), "base\n");
        git(["add", initialFile]);
    }
    git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "base",
    ]);
    if (scenario === "staged deletion") git(["rm", "-q", file]);
    if (scenario === "mode") await chmod(path.join(root, file), 0o755);
    if (scenario === "rename mode") await chmod(path.join(root, initialFile), 0o755);
    if (scenario === "intent") {
        await writeFile(path.join(root, file), "base\n");
        git(["add", "-N", file]);
    }
    if (scenario === "staged addition") {
        await writeFile(path.join(root, file), "base\n");
        git(["add", file]);
    }
    if (scenario === "staged edit") {
        await writeFile(path.join(root, file), "staged\n");
        git(["add", file]);
        await writeFile(path.join(root, file), "base\n");
    }
    if (scenario === "symlink edit") {
        await rm(path.join(root, file));
        await symlink("edited-target", path.join(root, file));
    }
    if (scenario === "type") {
        await rm(path.join(root, file));
        await symlink("base\n", path.join(root, file));
    }
    const store = new ChangelistStore();
    await store.connect(root, gitDir);
    if (scenario === "owner") await store.reconcileFiles(root, [file]);
    if (scenario === "rename source owner") await store.reconcileFiles(root, [initialFile]);
    if (scenario === "rename destination owner") await store.reconcileFiles(root, [file]);
    if (scenario === "range metadata" || scenario === "partial owner") {
        const bytes = changeFingerprint("base\n");
        const partial = scenario === "partial owner";
        const prior = changeFingerprint("prior\n");
        if (partial) await writeFile(path.join(root, file), "base\nprior\n");
        await store.track(root, file, {
            contentId: partial ? prior : bytes,
            baseHash: bytes,
            workingHash: partial ? changeFingerprint("base\nprior\n") : bytes,
            head: git(["rev-parse", "HEAD"]).toString().trim(),
            indexHash: changeFingerprint(await readFile(path.join(gitDir, "index"))),
            baseLines: [bytes],
            workingLines: partial ? [bytes, prior] : [bytes],
            anchors: partial
                ? [
                      {
                          kind: "add",
                          line: 1,
                          id: "0:0",
                          fingerprint: prior,
                          hash: prior,
                          context: [bytes, prior],
                      },
                  ]
                : [],
        });
        if (partial) {
            const withOwner = await store.create(root, store.revision(root), "Prior owner");
            const owner = withOwner.lists.find((list) => list.name === "Prior owner")!.id;
            await store.assignChanges(
                root,
                store.revision(root),
                file,
                prior,
                owner,
                [prior],
                new Set([prior]),
            );
            expect(
                Object.values(store.get(root).changes[file].lines),
                "fixture retains actual partial line ownership",
            ).toContain(owner);
        }
    }
    const persistence = await ChangelistPersistence.open(root, gitDir);
    const object = async (bytes: Buffer) => ({
        hash: await persistence.storeTargetOperationObject(bytes),
        size: bytes.length,
    });
    const capturePath = async (relative = file): Promise<TargetPathState> => {
        const info = await lstat(path.join(root, relative), { bigint: true }).catch(
            () => undefined,
        );
        if (!info) return { kind: "absent" };
        const identity = {
            device: String(info.dev),
            inode: String(info.ino),
            size: Number(info.size),
            modifiedNs: String(info.mtimeNs),
            changedNs: String(info.ctimeNs),
        };
        return info.isSymbolicLink()
            ? {
                  kind: "symlink",
                  target: await object(Buffer.from(await readlink(path.join(root, relative)))),
                  identity,
              }
            : {
                  kind: "regular",
                  executable: (info.mode & 0o111n) !== 0n,
                  content: await object(await readFile(path.join(root, relative))),
                  identity,
              };
    };
    const head = git(["rev-parse", "HEAD"]).toString().trim();
    const captureHead = async (relative: string) => {
        const tree = git(["ls-tree", "-z", head, "--", relative]).toString();
        const treeParts = tree.split(/[ \t]/);
        return tree
            ? {
                  kind: "present" as const,
                  mode: treeParts[0] as "100644",
                  oid: treeParts[2],
                  object: await object(git(["cat-file", "blob", treeParts[2]])),
              }
            : { kind: "absent" as const };
    };
    const headEntry = await captureHead(file);
    const index = await Promise.all(
        git(["ls-files", "--stage", "-z", "--", ...affected])
            .toString()
            .split("\0")
            .filter(Boolean)
            .map(async (line) => {
                const [mode, oid, stage] = line.split(/[ \t]/);
                return {
                    path: line.split("\t")[1],
                    mode: mode as "100644",
                    oid,
                    stage: Number(stage) as 0,
                    object: await object(git(["cat-file", "blob", oid])),
                    assumeUnchanged: false,
                    skipWorktree: false,
                    intentToAdd: scenario === "intent",
                };
            }),
    );
    let before: TargetOperationEvidence = {
        version: 1,
        operationId,
        root,
        gitDir,
        checkpoint: "before",
        head,
        indexFingerprint: changeFingerprint(
            await readFile(path.join(gitDir, "index")).catch(() => Buffer.alloc(0)),
        ),
        paths: await Promise.all(
            affected.map(async (relative) => ({
                path: relative,
                state: await capturePath(relative),
            })),
        ),
        index,
        native: ["cherryPickHead", "revertHead", "mergeHead", "sequencer"].map((name) => ({
            name: name as "cherryPickHead",
            present: false,
        })),
        entries: [
            { path: file, changeId: "whole-1", outcome: "pending" },
            ...(scenario === "missing success"
                ? [{ path: file, changeId: "whole-2", outcome: "pending" as const }]
                : []),
        ],
        wholeFileBefore: await Promise.all(
            affected.map(async (relative) => ({
                path: relative,
                head: await captureHead(relative),
                unowned: targetPathUnowned(store.get(root), relative),
            })),
        ),
    };
    if (alterBefore) before = alterBefore(before);
    const evidenceHash = await persistence.storeTargetOperationEvidence(before);
    const request = {
        id: operationId,
        kind: "patchApply" as const,
        target: { kind: "new" as const, name: "Destination", revision: store.revision(root) },
        headBefore: head,
        evidenceHash,
    };
    let lease = await store.acquireTargetOperationLease(root);
    let prepared;
    try {
        prepared = (await store.prepareTargetOperation(lease, request)).state;
    } finally {
        await lease.release();
    }
    const absent = before.paths[0].state.kind === "absent";
    const previous = link
        ? scenario === "symlink edit"
            ? "edited-target"
            : "base-target"
        : "base";
    const patch =
        scenario === "partial owner"
            ? `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n-base\n+operation\n prior\n`
            : absent
              ? `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+operation\n`
              : `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${previous}\n${link ? "\\ No newline at end of file\n" : ""}+operation\n${link ? "\\ No newline at end of file\n" : ""}`;
    if (scenario === "type") {
        await rm(path.join(root, file));
        await writeFile(path.join(root, file), "base\n");
    }
    git(
        ["apply"],
        sourcePath
            ? `diff --git a/${sourcePath} b/${file}\nsimilarity index 100%\nrename from ${sourcePath}\nrename to ${file}\n`
            : patch,
    );
    if (scenario === "rename retained source")
        await writeFile(path.join(root, initialFile), "external\n");
    const after: TargetOperationEvidence = {
        ...before,
        wholeFileBefore: undefined,
        checkpoint: "after",
        previousEvidenceHash: evidenceHash,
        paths: await Promise.all(
            affected.map(async (relative) => ({
                path: relative,
                state: await capturePath(relative),
            })),
        ),
        entries: before.entries.map((entry) => ({ ...entry, outcome: "applied" })),
        wholeFileAttribution:
            scenario === "missing attribution"
                ? undefined
                : [{ path: file, changeIds: ["whole-1"], ...(sourcePath ? { sourcePath } : {}) }],
    };
    const afterHash = await persistence.storeTargetOperationEvidence(after);
    lease = await store.acquireTargetOperationLease(root);
    let checkpoint;
    try {
        checkpoint = await store.checkpointTargetOperation(lease, {
            id: operationId,
            revision: prepared.revision,
            expectedPhase: "prepared",
            phase: "gitApplied",
            evidenceHash: afterHash,
        });
    } finally {
        await lease.release();
    }
    return {
        root,
        gitDir,
        git,
        store,
        persistence,
        before,
        after,
        afterHash,
        checkpoint,
        request,
        headEntry,
        capturePath,
    };
}

describe("target operation structural attribution", () => {
    it.each(["tracked", "absent", "symlink", "rename"])(
        "assigns a clean real %s whole-file result and survives missing Git blob",
        async (scenario) => {
            const f = await structuralFixture(scenario);
            if (f.headEntry.kind === "present")
                await rm(
                    path.join(
                        f.gitDir,
                        "objects",
                        f.headEntry.oid.slice(0, 2),
                        f.headEntry.oid.slice(2),
                    ),
                );
            const reopened = new ChangelistStore();
            await reopened.connect(f.root, f.gitDir);
            const lease = await reopened.acquireTargetOperationLease(f.root);
            try {
                const result = await reopened.publishTargetOwnership(lease, {
                    id: operationId,
                    revision: f.checkpoint.revision,
                    expectedPhase: "gitApplied",
                    observedEvidenceHash: f.afterHash,
                });
                expect(
                    result.pendingTargetOperation?.phase,
                    "clean structural evidence permits whole-file ownership",
                ).toBe("ownershipPublished");
                expect(result.files[file]).toBe(result.pendingTargetOperation?.destinationId);
                if (scenario === "rename")
                    expect(
                        result.files["src/source.ts"],
                        "the removed rename source belongs to the same destination",
                    ).toBe(result.pendingTargetOperation?.destinationId);
                expect(result.changes[file]).toBeUndefined();
                expect(result.pendingTargetOperation?.requestHash).toBe(
                    f.checkpoint.pendingTargetOperation?.requestHash,
                );
                await f.persistence.validateEvidence(result);
            } finally {
                await lease.release();
            }
        },
    );
    it("assigns a clean path whose record owns no live change, replacing that record", async () => {
        const f = await structuralFixture("range metadata");
        const lease = await f.store.acquireTargetOperationLease(f.root);
        try {
            const result = await f.store.publishTargetOwnership(lease, {
                id: operationId,
                revision: f.checkpoint.revision,
                expectedPhase: "gitApplied",
                observedEvidenceHash: f.afterHash,
            });
            expect(
                result.pendingTargetOperation?.phase,
                "a record with no counted change, line or anchor is not a pre-existing owner",
            ).toBe("ownershipPublished");
            expect(result.files[file]).toBe(result.pendingTargetOperation?.destinationId);
            expect(result.changes[file], "the consumed record is replaced").toBeUndefined();
        } finally {
            await lease.release();
        }
    });
    it.for([
        "staged deletion",
        "staged addition",
        "staged edit",
        "mode",
        "owner",
        "partial owner",
        "intent",
        "symlink edit",
        "rename source owner",
        "rename destination owner",
        "rename mode",
        "rename retained source",
        "type",
        "missing success",
        "missing attribution",
    ])("retains review for real preexisting %s", async (scenario, { skip }) => {
        skip(
            process.platform === "win32" && (scenario === "mode" || scenario === "rename mode"),
            "chmod cannot set an execute bit on Windows, so there is no mode change to review",
        );
        const f = await structuralFixture(scenario);
        const lease = await f.store.acquireTargetOperationLease(f.root);
        try {
            const result = await f.store.publishTargetOwnership(lease, {
                id: operationId,
                revision: f.checkpoint.revision,
                expectedPhase: "gitApplied",
                observedEvidenceHash: f.afterHash,
            });
            expect(
                result.pendingTargetOperation?.phase,
                "ownership absence alone does not prove a clean before representation",
            ).toBe("reviewRequired");
            expect(result.files).toEqual(f.checkpoint.files);
            expect(result.changes).toEqual(f.checkpoint.changes);
        } finally {
            await lease.release();
        }
    });
    it.each(["operation", "HEAD", "path", "OID", "object"])(
        "refuses corrupt captured %s evidence before creating the destination",
        async (part) => {
            await expect(
                structuralFixture("tracked", (before) => {
                    if (part === "operation")
                        return { ...before, operationId: "00000000-0000-4000-8000-000000000099" };
                    if (part === "HEAD") return { ...before, head: "f".repeat(40) };
                    const entry = before.wholeFileBefore![0];
                    const head = entry.head;
                    if (head.kind !== "present")
                        throw new Error("tracked fixture requires HEAD entry");
                    return {
                        ...before,
                        wholeFileBefore: [
                            {
                                ...entry,
                                ...(part === "path" ? { path: "other.ts" } : {}),
                                head: {
                                    ...head,
                                    ...(part === "OID" ? { oid: "f".repeat(40) } : {}),
                                    ...(part === "object"
                                        ? { object: { ...head.object, hash: "e".repeat(64) } }
                                        : {}),
                                },
                            },
                        ],
                    };
                }),
                "captured structural evidence must bind to the actual operation, HEAD, path and object",
            ).rejects.toThrow();
            const reopened = new ChangelistStore();
            const latestRoot = roots.at(-1)!;
            await reopened.connect(latestRoot, path.join(latestRoot, ".git"));
            expect(
                reopened.get(latestRoot).pendingTargetOperation,
                "invalid structural evidence cannot publish prepared metadata",
            ).toBeUndefined();
            expect(reopened.get(latestRoot).lists.some((list) => list.name === "Destination")).toBe(
                false,
            );
        },
    );
    it("refuses a false ownership-absence observation at prepare", async () => {
        await expect(
            structuralFixture("owner", (before) => ({
                ...before,
                wholeFileBefore: before.wholeFileBefore!.map((entry) => ({
                    ...entry,
                    unowned: true,
                })),
            })),
            "the metadata observation is verified by the store before Git",
        ).rejects.toThrow(/ownership observation/i);
    });
    it("requires explicit captured HEAD evidence rather than inferring cleanliness", async () => {
        const f = await structuralFixture("absent", (before) => ({
            ...before,
            wholeFileBefore: undefined,
        }));
        const lease = await f.store.acquireTargetOperationLease(f.root);
        try {
            const result = await f.store.publishTargetOwnership(lease, {
                id: operationId,
                revision: f.checkpoint.revision,
                expectedPhase: "gitApplied",
                observedEvidenceHash: f.afterHash,
            });
            expect(result.pendingTargetOperation?.phase).toBe("reviewRequired");
            expect(result.files).toEqual(f.checkpoint.files);
        } finally {
            await lease.release();
        }
    });
    it("requires actual after observation before publishing structural ownership", async () => {
        const f = await structuralFixture();
        await writeFile(path.join(f.root, file), "external edit\n");
        const observedEvidenceHash = await f.persistence.storeTargetOperationEvidence({
            ...f.after,
            paths: [{ path: file, state: await f.capturePath() }],
        });
        const lease = await f.store.acquireTargetOperationLease(f.root);
        try {
            const result = await f.store.publishTargetOwnership(lease, {
                id: operationId,
                revision: f.checkpoint.revision,
                expectedPhase: "gitApplied",
                observedEvidenceHash,
            });
            expect(
                result.pendingTargetOperation?.phase,
                "structural attribution does not bypass actual after observation",
            ).toBe("reviewRequired");
            expect(result.files).toEqual(f.checkpoint.files);
        } finally {
            await lease.release();
        }
    });
    it("rechecks current ownership after the captured unowned before state", async () => {
        const f = await structuralFixture();
        const external = structuredClone(f.checkpoint);
        external.files[file] = "default";
        external.revision++;
        const release = await f.persistence.acquire();
        try {
            await f.persistence.write(external);
        } finally {
            await release();
        }
        const lease = await f.store.acquireTargetOperationLease(f.root);
        try {
            const result = await f.store.publishTargetOwnership(lease, {
                id: operationId,
                revision: external.revision,
                expectedPhase: "gitApplied",
                observedEvidenceHash: f.afterHash,
            });
            expect(
                result.pendingTargetOperation?.phase,
                "later metadata ownership cannot be overwritten by captured absence",
            ).toBe("reviewRequired");
            expect(result.files).toEqual(external.files);
        } finally {
            await lease.release();
        }
    });
    it("rejects malformed, cross-path and overlapping whole-file attribution", async () => {
        const f = await structuralFixture("rename");
        for (const wholeFileAttribution of [
            [{ path: file, changeIds: [] }],
            [{ path: file, changeIds: ["unknown"] }],
            [{ path: "other.ts", changeIds: ["whole-1"] }],
            [{ path: file, changeIds: ["whole-1"], sourcePath: file }],
            [{ path: file, changeIds: ["whole-1"], clean: true }],
            [...f.after.wholeFileAttribution!, ...f.after.wholeFileAttribution!],
        ])
            expect(
                parseTargetOperationEvidence(
                    { ...f.after, wholeFileAttribution },
                    f.root,
                    f.gitDir,
                ),
            ).toBeUndefined();
        expect(
            parseTargetOperationEvidence(
                { ...f.before, wholeFileBefore: [{ ...f.before.wholeFileBefore![0], head: {} }] },
                f.root,
                f.gitDir,
            ),
        ).toBeUndefined();
    });
});
