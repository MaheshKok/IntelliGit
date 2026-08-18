/**
 * Refs + HEAD section (PLAN.md step 9: "All refs enumerated exhaustively (`for-each-ref` over the
 * full namespace, not just branches/tags/remotes), plus `HEAD`, `refs/stash`, and all reflogs").
 *
 * A bare, patternless `git for-each-ref` already walks the *entire* `refs/` namespace -- branches,
 * tags, remote-tracking refs, `refs/stash`, `refs/bisect/*`, and any custom ref a caller wrote
 * with `update-ref` -- confirmed empirically (a custom `refs/custom/mything` and a pushed
 * `refs/stash` both appeared with no pattern argument). `refs/stash` is named explicitly in the
 * plan for emphasis, not because it needs a separate command.
 *
 * `HEAD` is a pseudo-ref outside `refs/`, so `for-each-ref` never reports it; it is read directly
 * off `$GIT_DIR/HEAD` so a detached checkout (a 40-character object id) is never confused with a
 * symbolic one (`ref: refs/heads/<name>`) -- `git symbolic-ref HEAD` would simply fail detached,
 * and `git rev-parse HEAD` would lose the distinction entirely.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { inventoryDirectory } from "./fsInventory";
import { runGit } from "./gitRun";
import type { FsEntry, HeadRef, RefEntry, Section } from "./snapshotTypes";
import { captured } from "./snapshotTypes";

const REF_FIELD_SEPARATOR = "\x1f";
const SYMBOLIC_HEAD_PREFIX = "ref: ";

export async function snapshotRefs(
    repoRoot: string,
    env: NodeJS.ProcessEnv,
): Promise<Section<readonly RefEntry[]>> {
    const raw = await runGit(
        repoRoot,
        [
            "for-each-ref",
            `--format=%(refname)${REF_FIELD_SEPARATOR}%(objecttype)${REF_FIELD_SEPARATOR}%(objectname)`,
        ],
        env,
    );
    const entries = raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => parseRefLine(line));
    return captured(entries.sort((a, b) => compareCodepoints(a.name, b.name)));
}

/** Plain UTF-16-code-unit ordering, not `localeCompare` -- see `fsInventory.ts`'s `compareCodepoints`
 * for why: this repo's default locale demonstrably reorders real fixture names relative to
 * codepoint order, which would make a cross-machine snapshot comparison spuriously diverge. */
function compareCodepoints(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function parseRefLine(line: string): RefEntry {
    const [name, objectType, objectId] = line.split(REF_FIELD_SEPARATOR);
    if (!name || !objectType || !objectId) {
        throw new Error(`snapshotRefs: malformed "for-each-ref" line: ${JSON.stringify(line)}`);
    }
    return { name, objectType, objectId };
}

/** Reads `$GIT_DIR/HEAD` directly, distinguishing a symbolic ref from a detached object id. */
export async function snapshotHead(gitDir: string): Promise<Section<HeadRef>> {
    const raw = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    if (raw.startsWith(SYMBOLIC_HEAD_PREFIX)) {
        return captured({
            kind: "symbolic",
            target: raw.slice(SYMBOLIC_HEAD_PREFIX.length).trim(),
        });
    }
    return captured({ kind: "detached", target: raw });
}

/**
 * Every reflog under one git directory's `logs/`, recursively -- `logs/HEAD` and, for every ref
 * that has one, `logs/refs/...`. A missing `logs/` directory (reflogs disabled, or a bare repo
 * with `core.logAllRefUpdates` off) is captured as a genuinely empty list, not `not-captured`:
 * the absence is real, verified data, not a read failure.
 */
export async function snapshotReflogs(gitDir: string): Promise<Section<readonly FsEntry[]>> {
    const logsRoot = path.join(gitDir, "logs");
    if (!(await pathExists(logsRoot))) return captured([]);
    return captured(await inventoryDirectory({ root: logsRoot }));
}

async function pathExists(candidate: string): Promise<boolean> {
    try {
        await stat(candidate);
        return true;
    } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
    }
}

function isNotFoundError(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}
