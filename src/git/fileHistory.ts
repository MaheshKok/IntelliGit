import type { GitExecutor } from "./executor";
import { assertValidBranchName } from "../utils/gitRefs";

import type { FileHistoryEntry } from "./fileHistoryTypes";
export type { FileHistoryEntry } from "./fileHistoryTypes";

/**
 * Resolves a merge side's filename against its selected raw parent, rather than
 * reusing rename metadata that belongs only to the first parent.
 */
export async function getFileHistoryParentPath(
    executor: Pick<GitExecutor, "run">,
    entry: FileHistoryEntry,
    parent: string,
): Promise<string> {
    if (!entry.parents.includes(parent)) throw new Error("Unknown history parent");
    if (parent === entry.parents[0]) return entry.previousPath ?? entry.pathAtRevision;
    const output = await executor.run([
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--find-renames",
        parent,
        entry.hash,
    ]);
    const fields = output.split("\0");
    for (let index = 0; index < fields.length - 1;) {
        const status = fields[index++];
        const before = fields[index++];
        const after = /^[RC]/.test(status) ? fields[index++] : before;
        if (after === entry.pathAtRevision) return before;
    }
    return entry.pathAtRevision;
}

/**
 * Reads newest-first history for one literal repository-relative filename.
 *
 * Git follows renames from the selected ref. Increasing the limit must rerun from
 * the same immutable ref: skipping commits independently loses rename ancestry.
 * NUL-delimited metadata and paths preserve tabs, newlines, and delimiter-like text.
 * Deletion rows retain the deleted path, which exists only in their parent tree.
 * Invalid inputs and Git failures reject; they are never reported as empty history.
 */
export async function getFileHistory(
    executor: Pick<GitExecutor, "run">,
    filePath: string,
    options: { ref?: string; limit?: number } = {},
): Promise<{ entries: FileHistoryEntry[]; hasMore: boolean }> {
    assertHistoryPath(filePath);
    const ref = assertValidBranchName(options.ref ?? "HEAD", "history ref");
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`Invalid history limit: ${limit}`);
    }
    const output = await executor.run([
        "--literal-pathspecs",
        "log",
        "--follow",
        "--root",
        "--find-renames",
        "--diff-merges=first-parent",
        "--date-order",
        "--name-status",
        "-z",
        "--no-color",
        "--no-decorate",
        "--no-show-signature",
        "--encoding=UTF-8",
        "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s",
        `--max-count=${limit + 1}`,
        ref,
        "--",
        filePath,
    ]);
    const history = parseHistory(output, filePath);
    const entries = history.slice(0, limit);
    if (entries.length) {
        // Ref names cannot contain NUL or newline. Peeling keeps annotated release tags
        // attached to the commit rather than the separate tag object.
        const refs = await executor.run([
            "for-each-ref",
            "--sort=refname",
            "--format=%(objectname)%00%(*objectname)%00%(refname)",
            "refs/heads/",
            "refs/remotes/",
            "refs/tags/",
        ]);
        const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
        for (const line of refs.split("\n")) {
            const [object, peeled, refName] = line.split("\0");
            const entry = byHash.get(peeled || object);
            if (!entry || !refName) continue;
            const kind = refName.startsWith("refs/tags/")
                ? "tag"
                : refName.startsWith("refs/remotes/")
                  ? "remote"
                  : "branch";
            (entry.refs ??= []).push({ name: refName.split("/").slice(2).join("/"), kind });
        }
    }
    return { entries, hasMore: history.length > limit };
}

/**
 * Enforces repository-relative scope without rewriting valid filename bytes.
 * Unlike object-spec path helpers, log's literal pathspec accepts newline names.
 * Callers supply Git's slash-separated repository paths, including on Windows.
 */
function assertHistoryPath(filePath: string): void {
    if (
        !filePath ||
        filePath.includes("\0") ||
        filePath.startsWith("/") ||
        /^[a-zA-Z]:[\\/]/.test(filePath) ||
        filePath.startsWith("\\\\") ||
        filePath.split("/").some((part) => !part || part === "." || part === "..")
    ) {
        throw new Error(`Invalid repository-relative history path: ${filePath}`);
    }
}

/** Decodes fixed-width metadata followed by Git's NUL-delimited name/status records. */
function parseHistory(output: string, filePath: string): FileHistoryEntry[] {
    if (!output) return [];
    const fields = output.split("\0");
    const entries: FileHistoryEntry[] = [];
    let offset = 0;
    let historicalPath = filePath;
    while (offset < fields.length - 1) {
        const metadata = fields.slice(offset, offset + 9);
        const [
            hash,
            parents,
            authorName,
            authorEmail,
            authoredAt,
            committerName,
            committerEmail,
            committedAt,
            subject,
        ] = metadata;
        if (metadata.length !== 9 || !/^[a-f0-9]{40,64}$/.test(hash ?? "")) {
            throw new Error("Malformed Git file history metadata");
        }
        offset += 9;
        const entry: FileHistoryEntry = {
            hash,
            parents: parents ? parents.split(" ") : [],
            authorName,
            authorEmail,
            authoredAt,
            committerName,
            committerEmail,
            committedAt,
            subject,
            pathAtRevision: historicalPath,
            status: "modified",
        };
        while (offset < fields.length - 1) {
            // Only the status token has the pretty-format/diff separating newline.
            // Never trim a path or a metadata field.
            const token = fields[offset].replace(/^\n/, "");
            if (/^[a-f0-9]{40,64}$/.test(token)) break;
            const change = readHistoryChange(fields, offset, token);
            offset = change.nextOffset;
            if (change.pathAtRevision !== historicalPath) continue;
            entry.status = change.status;
            entry.previousPath = change.previousPath;
        }
        entries.push(entry);
        if (entry.previousPath) historicalPath = entry.previousPath;
    }
    return entries;
}

/** Consumes one name/status record; rename records contain two untouched path fields. */
function readHistoryChange(
    fields: string[],
    offset: number,
    token: string,
): {
    nextOffset: number;
    pathAtRevision: string;
    previousPath?: string;
    status: FileHistoryEntry["status"];
} {
    const statuses: Record<string, FileHistoryEntry["status"]> = {
        A: "added",
        M: "modified",
        D: "deleted",
        T: "type-changed",
        R: "renamed",
    };
    if (!/^(?:[AMDT]|R\d+)$/.test(token)) throw new Error("Malformed Git file history status");
    const renamed = token.startsWith("R");
    const beforePath = fields[offset + 1];
    const pathAtRevision = fields[offset + (renamed ? 2 : 1)];
    if (!beforePath || !pathAtRevision) throw new Error("Malformed Git file history path");
    return {
        nextOffset: offset + (renamed ? 3 : 2),
        pathAtRevision,
        previousPath: renamed ? beforePath : undefined,
        status: statuses[token[0]],
    };
}
