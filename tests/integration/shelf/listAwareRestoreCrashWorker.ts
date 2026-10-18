import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { ShelfService, type UnshelveInput } from "../../../src/services/shelfService";
import type { ShelfRestoreTarget } from "../../../src/services/shelfTargetRestore";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";

const [root, mode] = process.argv.slice(2);
const input = JSON.parse(
    await readFile(path.join(root, "restore-input.json"), "utf8"),
) as UnshelveInput & { targetOperation: ShelfRestoreTarget };
const changelists = new ChangelistStore();
await changelists.connect(root, path.join(root, ".git"));
const store = new ShelfStore(
    await resolveShelfPaths({
        repositoryRoot: root,
        globalStoragePath: path.join(root, "shelf-storage"),
    }),
    {
        publicationCheckpoint: async (phase) => {
            if (mode === "crash" && phase === "pointer") process.kill(process.pid, "SIGKILL");
        },
    },
);
const executor = new GitExecutor(root);
const runBinary = executor.runBinary.bind(executor);
executor.runBinary = async (args, options) => {
    const result = await runBinary(args, options);
    if (JSON.stringify(args) === JSON.stringify(["apply", "-"]))
        await appendFile(path.join(root, "restore-apply-count"), "1\n");
    return result;
};
const service = new ShelfService({
    repositoryRoot: root,
    executor,
    store,
    changelists,
    gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
});
const result = await service.unshelve(input);
await writeFile(
    path.join(root, "restore-result.json"),
    JSON.stringify({ result, state: changelists.get(root) }),
);
