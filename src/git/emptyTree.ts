import { GitExecutor } from "./executor";

/**
 * Reads the empty-tree object ID for the repository's configured object format.
 *
 * Git derives this value so SHA-1 and SHA-256 repositories are both supported
 * without embedding a format-specific constant in callers.
 */
export async function readEmptyTreeOid(
    executor: GitExecutor,
    invalidOidError: (message: string) => Error = (message) => new Error(message),
): Promise<string> {
    const result = await executor.runBinary(["hash-object", "-t", "tree", "--stdin"], {
        input: Buffer.alloc(0),
        maxOutputBytes: 128,
    });
    const treeId = result.stdout.toString("utf8").trim();
    if (!/^[a-f0-9]{40,64}$/i.test(treeId)) {
        throw invalidOidError("Git returned an invalid empty-tree ID.");
    }
    return treeId;
}
