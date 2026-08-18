/**
 * Orchestrates the full restorable domain for one repository (PLAN.md step 9: "it covers, for
 * *both* the workspace and the bare origin"). `snapshot.ts` calls this once per repository root.
 */

import path from "node:path";
import { runGit } from "./gitRun";
import { snapshotGitDirState } from "./snapshotGitDirState";
import { snapshotIndex } from "./snapshotIndex";
import { snapshotObjectStore } from "./snapshotObjectStore";
import { snapshotHead, snapshotReflogs, snapshotRefs } from "./snapshotRefs";
import type { RepositorySnapshot } from "./snapshotTypes";
import { snapshotWorkingTree } from "./snapshotWorkingTree";
import { snapshotWorktrees } from "./snapshotWorktrees";

export async function snapshotRepository(
    repoRoot: string,
    env: NodeJS.ProcessEnv,
): Promise<RepositorySnapshot> {
    const [isBareRaw, commonDirRaw] = await Promise.all([
        runGit(repoRoot, ["rev-parse", "--is-bare-repository"], env),
        runGit(repoRoot, ["rev-parse", "--git-common-dir"], env),
    ]);
    const isBare = isBareRaw === "true";
    const commonDir = path.resolve(repoRoot, commonDirRaw);

    const [workingTree, index, refs, head, reflogs, objectStore, worktreesResult] =
        await Promise.all([
            snapshotWorkingTree(repoRoot, isBare),
            snapshotIndex(repoRoot, env),
            snapshotRefs(repoRoot, env),
            snapshotHead(commonDir),
            snapshotReflogs(commonDir),
            snapshotObjectStore(repoRoot, commonDir, env),
            snapshotWorktrees(repoRoot, commonDir, env),
        ]);
    const gitDirState = await snapshotGitDirState(commonDir, worktreesResult.linkedGitDirs);

    return {
        repoRoot,
        commonDir,
        isBare,
        workingTree,
        index,
        refs,
        head,
        reflogs,
        worktrees: worktreesResult.section,
        gitDirState,
        objectStore,
    };
}
