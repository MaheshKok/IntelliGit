import { fork } from "node:child_process";
import { copyFile, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { expect } from "vitest";
import { ChangelistStore, type TargetOperationLease } from "../../src/changes/changelistStore";
import { ChangelistPersistence } from "../../src/changes/changelistPersistence";
import { GitExecutor } from "../../src/git/executor";
import { abortTargetNativeOperation } from "../../src/git/targetOperationRecovery";

/** Kill a real lock-owning process, age only its disposable test locks, then recover in a new store. */
export async function restartNativeRecoveryAfterProcessExit(
    root: string,
    previousLease: TargetOperationLease,
    stop: string,
    occurrence: number,
    expectBusy: boolean,
    candidate?: "redirected" | "replaced",
): Promise<{ store: ChangelistStore; lease: TargetOperationLease }> {
    await previousLease.release();
    const worker = path.join(root, "native-crash-worker.cjs");
    await build({
        entryPoints: [path.resolve("tests/fixtures/targetNativeRecoveryCrashWorker.ts")],
        outfile: worker,
        bundle: true,
        platform: "node",
        format: "cjs",
        logLevel: "silent",
    });
    const child = fork(worker, [root, stop, String(occurrence)], { execArgv: [], stdio: "pipe" });
    let errors = "";
    child.stderr?.on("data", (chunk) => {
        errors += String(chunk);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
    });
    expect(code, `worker must exit at ${stop}: ${errors}`).toBe(72);
    const gitDir = path.join(root, ".git");
    for (const relative of ["intelligit/changelists/metadata.lock", "intelligit/repo.lock"]) {
        const file = path.join(gitDir, relative);
        const owner = JSON.parse(await readFile(file, "utf8")) as { heartbeatAt: number };
        owner.heartbeatAt = 0;
        await writeFile(file, JSON.stringify(owner));
    }
    const store = new ChangelistStore();
    await store.connect(root, gitDir);
    const lease = await store.acquireTargetOperationLease(root);
    try {
        const state = store.get(root);
        const pending = state.pendingTargetOperation!;
        const persistence = await ChangelistPersistence.open(root, gitDir);
        const saved = await persistence.loadTargetOperationEvidence(pending.evidenceHash);
        if (saved.indexPublication)
            expect(
                saved.indexPublication.lock.owner,
                "durable lock owner must match the exact child process creation identity",
            ).toEqual(
                JSON.parse(await readFile(path.join(root, "native-worker-identity.json"), "utf8")),
            );
        if (candidate) {
            const evidence = await persistence.loadTargetOperationEvidence(pending.evidenceHash);
            const file = path.join(gitDir, evidence.indexPublication!.candidate.path);
            if (candidate === "redirected") {
                await rename(file, `${file}.redirected`);
                await symlink(`${file}.redirected`, file);
            } else {
                // The same bytes in a new file: only the saved identity tells the two apart.
                await copyFile(file, `${file}.copy`);
                await rename(`${file}.copy`, file);
            }
        }
        const operation = abortTargetNativeOperation(
            new GitExecutor(root),
            persistence,
            store,
            lease,
            { id: pending.id, revision: state.revision, expectedPhase: pending.phase },
        );
        if (candidate === "replaced") {
            await expect(
                operation,
                "a published index must not be claimed through a replaced candidate",
            ).rejects.toThrow("Recovery candidate identity changed.");
            expect(store.get(root).pendingTargetOperation).toBeDefined();
        } else if (expectBusy) {
            await expect(
                operation,
                "an unacknowledged or changed index lock must remain busy",
            ).rejects.toThrow();
            expect(store.get(root).pendingTargetOperation).toBeDefined();
            expect(await readFile(path.join(gitDir, "index.lock"))).toBeDefined();
        } else await operation;
        return { store, lease };
    } catch (error) {
        await lease.release();
        throw error;
    }
}
