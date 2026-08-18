/**
 * Object-store integrity (PLAN.md step 9: "an object inventory, plus an assertion that
 * `objects/info/alternates` is either absent or points only inside the copy -- an alternates file
 * still pointing at the template would make copies silently share objects").
 *
 * The inventory is every object git knows about (`git cat-file --batch-all-objects`), not a raw
 * listing of `objects/`: pack-vs-loose representation is storage detail, not object-store state,
 * confirmed empirically to work identically against a fresh repository.
 *
 * `assertAlternatesContained` is deliberately a separate, pure function rather than something
 * `snapshotObjectStore` throws internally: capture stays descriptive (safe to call for diffing
 * even against an already-known-bad copy), and the assertion is independently callable by a test,
 * which is what proves it can fail.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./gitRun";
import type {
    AlternatesInfo,
    ObjectStoreEntry,
    ObjectStoreSnapshot,
    Section,
} from "./snapshotTypes";
import { captured } from "./snapshotTypes";

const OBJECT_LINE_FORMAT = "%(objectname) %(objecttype) %(objectsize)";

export async function snapshotObjectStore(
    repoRoot: string,
    commonDir: string,
    env: NodeJS.ProcessEnv,
): Promise<Section<ObjectStoreSnapshot>> {
    const [objects, alternates] = await Promise.all([
        listObjects(repoRoot, env),
        readAlternates(commonDir),
    ]);
    return captured({ objects, alternates });
}

async function listObjects(
    repoRoot: string,
    env: NodeJS.ProcessEnv,
): Promise<readonly ObjectStoreEntry[]> {
    const raw = await runGit(
        repoRoot,
        ["cat-file", "--batch-all-objects", `--batch-check=${OBJECT_LINE_FORMAT}`],
        env,
    );
    if (raw.length === 0) return [];
    return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseObjectLine)
        .sort((a, b) => compareCodepoints(a.objectId, b.objectId));
}

/** Plain UTF-16-code-unit ordering, not `localeCompare` -- see `fsInventory.ts`'s `compareCodepoints`
 * for why: this repo's default locale demonstrably reorders real fixture names relative to
 * codepoint order, which would make a cross-machine snapshot comparison spuriously diverge. Object
 * ids are hex, so this never actually changes ordering here -- kept for the same reason as the
 * other three call sites: consistency of the seam this suite depends on. */
function compareCodepoints(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function parseObjectLine(line: string): ObjectStoreEntry {
    const [objectId, objectType, sizeText] = line.split(" ");
    const size = Number(sizeText);
    if (!objectId || !objectType || Number.isNaN(size)) {
        throw new Error(
            `snapshotObjectStore: malformed "cat-file --batch-all-objects" line: ${JSON.stringify(line)}`,
        );
    }
    return { objectId, objectType, size };
}

async function readAlternates(commonDir: string): Promise<AlternatesInfo> {
    const objectsDir = path.join(commonDir, "objects");
    const alternatesPath = path.join(objectsDir, "info", "alternates");
    const raw = await readIfPresent(alternatesPath);
    if (raw === null) return { present: false, rawLines: [], resolvedAbsolutePaths: [] };

    const rawLines = raw.split("\n").filter((line) => line.length > 0);
    const resolvedAbsolutePaths = rawLines.map((line) => path.resolve(objectsDir, line));
    return { present: true, rawLines, resolvedAbsolutePaths };
}

async function readIfPresent(candidate: string): Promise<string | null> {
    try {
        return await readFile(candidate, "utf8");
    } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
    }
}

function isNotFoundError(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

/**
 * Asserts every alternates line resolves inside one of `allowedRoots` (each an absolute directory
 * prefix -- typically the copy's `<ROOT>` and `<ORIGIN>` directories). Throws with every offending
 * path listed, rather than returning a boolean, so a failing test's message is self-explanatory.
 * A test proves this can fail by planting an alternates file that points outside the copy.
 */
export function assertAlternatesContained(
    alternates: AlternatesInfo,
    allowedRoots: readonly string[],
): void {
    if (!alternates.present) return;
    const offending = alternates.resolvedAbsolutePaths.filter(
        (candidate) => !allowedRoots.some((root) => isWithin(root, candidate)),
    );
    if (offending.length > 0) {
        throw new Error(
            `objects/info/alternates points outside every allowed root (${allowedRoots.join(", ")}): ` +
                offending.join(", "),
        );
    }
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
