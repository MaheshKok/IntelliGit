import { PartialChanges } from "../../../src/git/partialChanges";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { ShelfReverter } from "../../../src/shelf/recovery";
import { ShelfStore } from "../../../src/shelf/store";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { changeIds } from "../../../src/changes/selection";
const [repositoryRoot, globalStoragePath, checkpoint] = process.argv.slice(2);
const executor = new GitExecutor(repositoryRoot);
const store = new ShelfStore(await resolveShelfPaths({ repositoryRoot, globalStoragePath }));
const reverter = new ShelfReverter({
    repositoryRoot,
    gitOps: new GitOps(executor),
    gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    store,
    checkpoint: async (actual) => {
        if (actual === checkpoint) process.kill(process.pid, "SIGKILL");
    },
});
const workflow = new PartialChanges(executor, repositoryRoot);
const view = await workflow.open("tracked.txt");
await workflow.rollback(
    { snapshotId: view.snapshotId, lineIds: changeIds(view.blocks.slice(0, 1)) },
    () => undefined,
    reverter,
    "process-crash",
);
