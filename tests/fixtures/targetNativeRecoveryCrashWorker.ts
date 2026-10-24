import path from "node:path";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { ChangelistPersistence } from "../../src/changes/changelistPersistence";
import { ChangelistStore } from "../../src/changes/changelistStore";
import { GitExecutor } from "../../src/git/executor";
import { abortTargetNativeOperation } from "../../src/git/targetOperationRecovery";

/** Crash without finally blocks so recovery sees real orphaned metadata, repository and index locks. */
async function main(): Promise<void> {
    const [root, stop, occurrenceText] = process.argv.slice(2);
    await writeFile(
        path.join(root, "native-worker-identity.json"),
        JSON.stringify({
            pid: process.pid,
            processStart: String(Math.trunc(performance.timeOrigin)),
        }),
    );
    const store = new ChangelistStore();
    const gitDir = path.join(root, ".git");
    await store.connect(root, gitDir);
    const persistence = await ChangelistPersistence.open(root, gitDir);
    const lease = await store.acquireTargetOperationLease(root);
    const state = store.get(root);
    const pending = state.pendingTargetOperation!;
    let occurrence = 0;
    await abortTargetNativeOperation(
        new GitExecutor(root),
        persistence,
        store,
        lease,
        {
            id: pending.id,
            revision: state.revision,
            expectedPhase: pending.phase,
        },
        async (checkpoint) => {
            if (checkpoint === stop && ++occurrence === Number(occurrenceText)) process.exit(72);
        },
    );
    await lease.release();
    process.exit(0);
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
