import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
    chmod,
    mkdtemp,
    readFile,
    realpath,
    rename,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChangelistPersistence } from "../../../src/changes/changelistPersistence";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { GitExecutor } from "../../../src/git/executor";
import {
    abortTargetNativeOperation,
    captureTargetNativeEvidence,
} from "../../../src/git/targetOperationRecovery";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const roots: string[] = [];
afterEach(async () => {
    await removeScratchDirectories(...roots);
});

it.each(["cherry-pick", "revert"] as const)(
    "restores %s additions deletions rename endpoints symlink bytes and executable modes",
    async (kind) => {
        const root = await realpath(await mkdtemp(path.join(tmpdir(), "target-native-structure-")));
        roots.push(root);
        const git = new GitExecutor(root);
        await git.run(["init", "-q"]);
        await git.run(["config", "user.name", "Fixture"]);
        await git.run(["config", "user.email", "fixture@example.invalid"]);
        await git.run(["config", "core.filemode", "true"]);
        for (const file of ["affected", "deleted", "rename-source", "executable", "unrelated"])
            await writeFile(path.join(root, file), `${file} base\n`);
        await symlink("base-target", path.join(root, "symbolic"));
        await git.run(["add", "."]);
        await git.run(["commit", "-qm", "base"]);
        const base = (await git.run(["rev-parse", "HEAD"])).trim();
        await writeFile(path.join(root, "affected"), "incoming\n");
        await writeFile(path.join(root, "added"), Buffer.from([0, 255, 128, 10]));
        await unlink(path.join(root, "deleted"));
        await rename(path.join(root, "rename-source"), path.join(root, "rename-destination"));
        await chmod(path.join(root, "executable"), 0o755);
        await unlink(path.join(root, "symbolic"));
        await symlink("changed-target", path.join(root, "symbolic"));
        await git.run(["add", "-A"]);
        await git.run(["commit", "-qm", "incoming structure"]);
        const commit = (await git.run(["rev-parse", "HEAD"])).trim();
        if (kind === "cherry-pick") await git.run(["checkout", "-q", base]);
        await writeFile(path.join(root, "affected"), "current\n");
        await git.run(["commit", "-qam", "current"]);
        await writeFile(path.join(root, "unrelated"), "staged\n");
        await git.run(["add", "unrelated"]);
        await writeFile(path.join(root, "unrelated"), "working\n");
        const gitDir = path.join(root, ".git");
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const store = new ChangelistStore();
        await store.connect(root, gitDir);
        const lease = await store.acquireTargetOperationLease(root);
        const affected = [
            "affected",
            "added",
            "deleted",
            "rename-source",
            "rename-destination",
            "executable",
            "symbolic",
        ];
        try {
            const id = randomUUID();
            const before = {
                ...(await captureTargetNativeEvidence(git, persistence, id, affected)),
                entries: [
                    { changeId: "native:affected", path: "affected", outcome: "pending" as const },
                ],
            };
            const hash = await persistence.storeTargetOperationEvidence(before);
            const prepared = await store.prepareTargetOperation(lease, {
                id,
                kind: kind === "cherry-pick" ? "cherryPick" : "revert",
                commit,
                headBefore: before.head,
                evidenceHash: hash,
                target: { kind: "existing", id: "default", revision: store.get(root).revision },
            });
            expect(
                (await git.runBinary([kind, "--no-commit", commit], { expectedExitCodes: [0, 1] }))
                    .exitCode,
            ).toBe(1);
            const after = {
                ...(await captureTargetNativeEvidence(git, persistence, id, affected)),
                checkpoint: "after" as const,
                previousEvidenceHash: hash,
                entries: [
                    {
                        changeId: "native:affected",
                        path: "affected",
                        outcome: "conflicted" as const,
                    },
                ],
            };
            const state = await store.checkpointTargetOperation(lease, {
                id,
                revision: prepared.state.revision,
                expectedPhase: "prepared",
                phase: "conflicted",
                evidenceHash: await persistence.storeTargetOperationEvidence(after),
            });
            await expect(
                abortTargetNativeOperation(git, persistence, store, lease, {
                    id,
                    revision: state.revision,
                    expectedPhase: "conflicted",
                }),
                "structural abort must restore all affected stages and representations",
            ).resolves.toBeUndefined();
            const restored = await captureTargetNativeEvidence(git, persistence, id, affected);
            expect(restored.head).toBe(before.head);
            expect(
                restored.index,
                "all structural stage/mode/OID entries must match before",
            ).toEqual(before.index);
            const representations = (evidence: typeof before) =>
                evidence.paths.map(({ path: file, state: fileState }) => ({
                    path: file,
                    state:
                        fileState.kind === "absent"
                            ? fileState
                            : Object.fromEntries(
                                  Object.entries(fileState).filter(([key]) => key !== "identity"),
                              ),
                }));
            expect(
                representations({ ...restored, entries: before.entries }),
                "raw type/content/executable state must match before",
            ).toEqual(representations(before));
            expect(await git.run(["show", ":unrelated"])).toBe("staged\n");
            expect(await readFile(path.join(root, "unrelated"), "utf8")).toBe("working\n");
            expect(store.get(root).pendingTargetOperation).toBeUndefined();
        } finally {
            await lease.release();
        }
    },
    240_000,
);
