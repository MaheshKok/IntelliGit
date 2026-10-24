import { ChangelistStore } from "../../src/changes/changelistStore";
import { GitExecutor } from "../../src/git/executor";
import { GitOps } from "../../src/git/operations";

/** Connects real durable metadata for a fixture's shelf service before it acquires its lease. */
export async function connectedChangelists(repositoryRoot: string): Promise<ChangelistStore> {
    const store = new ChangelistStore();
    const directories = await new GitOps(new GitExecutor(repositoryRoot)).getGitDirectories();
    await store.connect(repositoryRoot, directories.gitDir);
    return store;
}
