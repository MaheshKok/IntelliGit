/**
 * Generic recursive filesystem digest-inventory. The one walker every section of the snapshot
 * that needs "what is really on disk here" builds on: the working tree, all reflogs, and every
 * git-admin directory's private state (PLAN.md step 9's "inventoried recursively, with a
 * documented exclusion list, never a hand-written include list").
 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, readdir, readlink, lstat } from "node:fs/promises";
import path from "node:path";
import type { FsEntry, FsEntryType } from "./snapshotTypes";

/** Files at or under this size are also captured as decoded text; see {@link FsEntry.text}. */
export const DEFAULT_TEXT_CAPTURE_LIMIT_BYTES = 65_536;

/** Returns `true` to skip `relativePath` (and, for a directory, everything under it). */
export type ExcludePredicate = (relativePath: string, type: FsEntryType) => boolean;

export interface InventoryDirectoryOptions {
    /** Absolute path to the directory to walk. Must exist. */
    readonly root: string;
    /** Skips matching entries; directories are pruned rather than recursed into. */
    readonly exclude?: ExcludePredicate;
    /** Overrides {@link DEFAULT_TEXT_CAPTURE_LIMIT_BYTES}. */
    readonly textCaptureLimitBytes?: number;
}

/**
 * Recursively inventories every entry under `options.root`, POSIX-relative to it, sorted for a
 * deterministic, diff-friendly order. Directories are recorded as entries too -- an emptied or
 * deleted directory must be visible in the inventory, not silently absorbed into "no files here."
 */
export async function inventoryDirectory(
    options: InventoryDirectoryOptions,
): Promise<readonly FsEntry[]> {
    const entries: FsEntry[] = [];
    await walk(options.root, "", options, entries);
    return entries.sort((a, b) => compareCodepoints(a.relativePath, b.relativePath));
}

/**
 * Plain UTF-16-code-unit ordering, deliberately NOT `String.prototype.localeCompare`.
 *
 * Confirmed empirically on this very machine: with no `LANG`/`LC_ALL` set, `Intl` resolves a
 * default locale (`en-US`) whose collation reorders real fixture names relative to codepoint
 * order -- e.g. `"file.txt"` sorts adjacent to `"FILE.txt"` instead of every uppercase name
 * sorting before every lowercase one. Phase 0's own gate requires this suite to agree between
 * macOS local and a pinned Linux container; a container with a different default locale (or no
 * ICU locale data at all, common in minimal images) would then order an otherwise IDENTICAL set
 * of entries differently, and a plain `toEqual` on the resulting array would report two
 * structurally identical snapshots as different -- a false failure in the oracle itself, the same
 * class of defect this plan's governing principle exists to eliminate, just manifesting as a
 * false red instead of a false green. `localeCompare`'s exported siblings in `snapshotIndex.ts`,
 * `snapshotRefs.ts`, and `snapshotObjectStore.ts` carry the same reasoning; each defines its own
 * private copy of this helper rather than importing one, matching this package's existing
 * convention of small duplicated private predicates (e.g. `isNotFoundError`).
 */
function compareCodepoints(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

async function walk(
    absoluteRoot: string,
    relativeDir: string,
    options: InventoryDirectoryOptions,
    out: FsEntry[],
): Promise<void> {
    const absoluteDir = path.join(absoluteRoot, relativeDir);
    const children = await readdir(absoluteDir, { withFileTypes: true });
    for (const child of children) {
        const relativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name;
        await visitEntry(absoluteRoot, relativePath, options, out);
    }
}

async function visitEntry(
    absoluteRoot: string,
    relativePath: string,
    options: InventoryDirectoryOptions,
    out: FsEntry[],
): Promise<void> {
    const absolutePath = path.join(absoluteRoot, relativePath);
    const stats: Stats = await lstat(absolutePath);
    const type = classify(stats);
    if (options.exclude?.(relativePath, type)) return;

    if (type === "directory") {
        out.push(await buildEntry(absolutePath, relativePath, type, stats, options));
        await walk(absoluteRoot, relativePath, options, out);
        return;
    }
    out.push(await buildEntry(absolutePath, relativePath, type, stats, options));
}

function classify(stats: Stats): FsEntryType {
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "special";
}

async function buildEntry(
    absolutePath: string,
    relativePath: string,
    type: FsEntryType,
    stats: Stats,
    options: InventoryDirectoryOptions,
): Promise<FsEntry> {
    const mode = stats.mode & 0o7777;
    if (type === "symlink") {
        const symlinkTarget = await readlink(absolutePath);
        return { relativePath, type, mode, digest: null, text: null, symlinkTarget };
    }
    if (type !== "file") {
        return { relativePath, type, mode, digest: null, text: null, symlinkTarget: null };
    }
    const buffer = await readFile(absolutePath);
    const digest = createHash("sha256").update(buffer).digest("hex");
    const text = decodeTextIfSmallAndValid(buffer, options.textCaptureLimitBytes);
    return { relativePath, type, mode, digest, text, symlinkTarget: null };
}

/** Decodes `buffer` as UTF-8 only when it round-trips exactly and stays within the capture limit. */
function decodeTextIfSmallAndValid(buffer: Buffer, limitBytes: number | undefined): string | null {
    const limit = limitBytes ?? DEFAULT_TEXT_CAPTURE_LIMIT_BYTES;
    if (buffer.byteLength > limit) return null;
    const text = buffer.toString("utf8");
    return Buffer.from(text, "utf8").equals(buffer) ? text : null;
}
