import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfReverter } from "../../../src/shelf/recovery";
import { ShelfStore } from "../../../src/shelf/store";
import { ShelfService } from "../../../src/services/shelfService";

const [repositoryRoot, storageRoot, checkpoint] = process.argv.slice(2);
if (!repositoryRoot || !storageRoot || !checkpoint)
    throw new Error("Missing crash-worker arguments.");

const executor = new GitExecutor(repositoryRoot);
const gate = new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock());
const store = new ShelfStore(
    await resolveShelfPaths({ repositoryRoot, globalStoragePath: storageRoot }),
);
const reverter = new ShelfReverter({
    repositoryRoot,
    gitOps: new GitOps(executor),
    gate,
    store,
    checkpoint: async (actualCheckpoint) => {
        if (actualCheckpoint === checkpoint) process.kill(process.pid, "SIGKILL");
    },
});
const service = new ShelfService({ repositoryRoot, executor, store, gate, reverter });
await service.shelve({
    name: "crash worker shelf",
    paths: ["tracked.txt"],
    silent: true,
    keepLocal: false,
});
