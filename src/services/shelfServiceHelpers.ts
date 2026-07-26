import path from "node:path";
import { validateShelfManifestPath } from "../shelf/importValidation";
import { selectWholeShelfEntries, type ShelfFileEntry } from "../shelf/model";

/** Identifies entries whose application requires an explicit structural choice. */
export function isStructural(entry: ShelfFileEntry): boolean {
    return (
        entry.binary ||
        [entry.indexBlock, entry.worktreeBlock].some(
            (block) => block?.status === "R" || block?.status === "D" || block?.status === "T",
        )
    );
}

/** Maps completed per-entry outcomes to the public aggregate shelf state. */
export function statusFor(
    entries: readonly { readonly kind: string }[],
): "ok" | "partial" | "conflicts" {
    if (
        entries.length === 0 ||
        entries.every((entry) => entry.kind === "applied" || entry.kind === "flattenedResidue")
    ) {
        return "ok";
    }
    if (
        entries.some((entry) => entry.kind === "conflicted" || entry.kind === "structuralPending")
    ) {
        return "conflicts";
    }
    return "partial";
}

/** Rejects partial logical-entry selection before any patch application starts. */
export function selectEntries(
    entries: readonly ShelfFileEntry[],
    changeIds: readonly string[] | undefined,
): ShelfFileEntry[] {
    if (!changeIds) return [...entries];
    const known = new Set(entries.map((entry) => entry.changeId));
    if (changeIds.some((id) => !known.has(id))) {
        throw new Error("Shelf selection contains an unknown change ID.");
    }
    return selectWholeShelfEntries(entries, changeIds);
}

/** Validates the durable, user-facing shelf name. */
export function assertShelfName(name: string): void {
    if (!name.trim() || name.length > 255 || name.includes("\0")) {
        throw new Error("Shelf name is invalid.");
    }
}

/** Resolves a manifest path without allowing a lexical repository escape. */
export function repositoryPath(repositoryRoot: string, relativePath: string): string {
    const safeRelativePath = validateShelfManifestPath(relativePath);
    const root = path.resolve(repositoryRoot);
    const target = path.resolve(root, safeRelativePath);
    const relation = path.relative(root, target);
    if (
        relation === "" ||
        relation === ".." ||
        relation.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relation)
    ) {
        throw new Error("Shelf path escapes the repository root.");
    }
    return target;
}

/** Detects text that round-trips exactly through UTF-8. */
export function isUtf8(bytes: Buffer): boolean {
    return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

/** Narrows Node's missing-path error without exposing host-specific details. */
export function isNotFound(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
