import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { changeFingerprint } from "./parseDiff";
import { assertRepoRelativePath } from "../utils/repoRelativePath";

/** Cheap cache invalidation only; mutations still require the full protected snapshot fences. */
export async function rangeObservation(gitDir: string, commonDir: string): Promise<string> {
    const head = (await boundedRead(path.join(gitDir, "HEAD"))).toString("utf8");
    const ref = /^ref: (refs\/[^\r\n]+)\s*$/.exec(head)?.[1];
    const files = [
        path.join(gitDir, "index"),
        path.join(commonDir, "packed-refs"),
        path.join(commonDir, "config"),
        path.join(gitDir, "config.worktree"),
        path.join(commonDir, "info/attributes"),
        ...["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].map(
            (name) => path.join(gitDir, name),
        ),
    ];
    if (ref) files.push(path.join(commonDir, assertRepoRelativePath(ref)));
    const contents = await Promise.all(files.map(boundedRead));
    return changeFingerprint(JSON.stringify([head, ...contents.map(changeFingerprint)]));
}

/** Missing optional Git metadata is distinct from unreadable or oversized metadata. */
async function boundedRead(filename: string): Promise<Buffer> {
    try {
        const stat = await lstat(filename);
        if (stat.isDirectory()) return Buffer.from("directory");
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024)
            throw new Error("Git metadata requires review.");
        return await readFile(filename);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return Buffer.alloc(0);
        throw error;
    }
}
