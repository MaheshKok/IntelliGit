import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { validateShelfManifestPath } from "./importValidation";
import { resolveNoFollowFlag } from "./noFollowFlag";
import { ensureContainedParent, resolveRepositoryPath } from "./recoveryPaths";

/** Writes raw shelf bytes only to an existing regular file contained by the repository. */
export async function replaceRegularWorktreeFile(
    repositoryRoot: string,
    relativePath: string,
    bytes: Uint8Array,
): Promise<void> {
    const target = resolveRepositoryPath(repositoryRoot, validateShelfManifestPath(relativePath));
    await ensureContainedParent(repositoryRoot, target);
    await assertRegularTarget(target);
    const file = await open(target, constants.O_WRONLY | constants.O_TRUNC | resolveNoFollowFlag());
    try {
        await file.writeFile(bytes);
        await file.sync();
    } finally {
        await file.close();
    }
    await ensureContainedParent(repositoryRoot, target);
    await assertRegularTarget(target);
}

async function assertRegularTarget(target: string): Promise<void> {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error("Raw shelf write requires an existing regular file.");
    }
}
