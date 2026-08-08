/**
 * The equivalence assertion PLAN.md step 8 requires (Codex R3 #5): "Equivalent to the template
 * modulo the declared rewrite set, and nothing else: after rehydration, a normalized diff against
 * the template must show only declared rewrites." Concretely: normalize both the template's own
 * snapshot and the rehydrated copy's snapshot (`normalizeSnapshot`, from `snapshotNormalize.ts`,
 * comparison-only -- see that module's doc comment), each with its OWN roots, then deep-compare
 * the two normalized values. A CORRECTLY rehydrated copy collapses every declared rewrite onto
 * the same placeholder the template already normalizes to (e.g. both sides' `.git/config` origin
 * URL becomes `<ORIGIN>`), so the normalized diff is empty. Anything left over is, by
 * construction, an undeclared difference -- a rewrite `rehydrateCopy` (`rehydrate.ts`) missed, or
 * something unrelated actually changed (a mutated file, divergent history, ...).
 *
 * Deliberately a separate, pure, independently callable function -- mirrors
 * `snapshotObjectStore.ts`'s `assertAlternatesContained` and `copyInodeGuard.ts`'s
 * `assertNoSharedInodes`: it never touches disk itself (both snapshots are captured by the
 * caller), and it throws once, listing every offending path, rather than on the first mismatch,
 * so a failing test's message is self-explanatory. `tests/unit/fixtures/rehydrate.test.ts` proves
 * it can fail, by planting an undeclared mutation in a rehydrated copy and asserting the thrown
 * message names it.
 */

import { normalizeSnapshot } from "./snapshotNormalize";
import type { PlaceholderRoots } from "./snapshotNormalize";
import type { WorkspaceSnapshot } from "./snapshotTypes";

/**
 * Asserts `copySnapshot` (captured at `copyRoots`) is equivalent to `templateSnapshot` (captured
 * at `templateRoots`) once both are normalized to placeholders. Throws one error naming every
 * differing path when they are not; does nothing when they are equivalent.
 */
export function assertWorkspaceEquivalentToTemplate(
    templateSnapshot: WorkspaceSnapshot,
    templateRoots: PlaceholderRoots,
    copySnapshot: WorkspaceSnapshot,
    copyRoots: PlaceholderRoots,
): void {
    const normalizedTemplate = normalizeSnapshot(templateSnapshot, templateRoots);
    const normalizedCopy = normalizeSnapshot(copySnapshot, copyRoots);

    const differences: string[] = [];
    collectDifferences("snapshot", normalizedTemplate, normalizedCopy, differences);

    if (differences.length > 0) {
        throw new Error(
            `Copy is not equivalent to the template after rehydration and normalization -- ` +
                `${differences.length} undeclared difference(s) found (every declared rewrite should ` +
                `already have collapsed to an identical placeholder on both sides): ${differences.join("; ")}`,
        );
    }
}

/** Narrows `value` to a readonly array, or `null` when it is not one -- kept separate from the
 * plain-object branch below so neither branch has to reason about the other's shape. */
function asArray(value: unknown): readonly unknown[] | null {
    return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

/** Narrows `value` to a plain string-keyed record, or `null` when it is not an object (or is
 * `null`, which `typeof` alone would otherwise call `"object"`). */
function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Common identity-ish keys across this package's array-of-object shapes (`FsEntry.relativePath`,
 * `RefEntry.name`, `WorktreeInfo.path`, `IndexEntry.path`, `ObjectStoreEntry.objectId`) -- when an
 * array element carries one, an error message names the actual file/ref/worktree instead of a
 * bare numeric index, without this module needing a per-type special case for every array shape
 * {@link WorkspaceSnapshot} contains. */
const IDENTITY_KEYS = ["relativePath", "name", "path", "objectId"] as const;

/** Labels one array element for a difference message, preferring a human-meaningful identity
 * (see {@link IDENTITY_KEYS}) over a bare index when either side's element carries one. */
function arrayElementLabel(pathLabel: string, index: number, expectedElement: unknown, actualElement: unknown): string {
    const expectedRecord = asRecord(expectedElement);
    const actualRecord = asRecord(actualElement);
    for (const key of IDENTITY_KEYS) {
        const identity = expectedRecord?.[key] ?? actualRecord?.[key];
        if (typeof identity === "string" && identity.length > 0) {
            return `${pathLabel}[${index}:${key}=${identity}]`;
        }
    }
    return `${pathLabel}[${index}]`;
}

/**
 * Recursively finds every differing leaf between `expected` and `actual`, appending a
 * human-readable, path-labelled entry to `out` for each -- generic over the whole snapshot shape
 * (arrays, plain objects, and primitives alike) so this never needs a per-field special case as
 * {@link WorkspaceSnapshot}'s shape grows.
 */
function collectDifferences(pathLabel: string, expected: unknown, actual: unknown, out: string[]): void {
    if (Object.is(expected, actual)) return;

    const expectedArray = asArray(expected);
    const actualArray = asArray(actual);
    if (expectedArray !== null || actualArray !== null) {
        if (expectedArray === null || actualArray === null) {
            out.push(`${pathLabel}: ${describe(expected)} !== ${describe(actual)}`);
            return;
        }
        if (expectedArray.length !== actualArray.length) {
            out.push(`${pathLabel}: length ${expectedArray.length} !== ${actualArray.length}`);
        }
        const maxLength = Math.max(expectedArray.length, actualArray.length);
        for (let index = 0; index < maxLength; index += 1) {
            const elementLabel = arrayElementLabel(pathLabel, index, expectedArray[index], actualArray[index]);
            collectDifferences(elementLabel, expectedArray[index], actualArray[index], out);
        }
        return;
    }

    const expectedRecord = asRecord(expected);
    const actualRecord = asRecord(actual);
    if (expectedRecord !== null || actualRecord !== null) {
        if (expectedRecord === null || actualRecord === null) {
            out.push(`${pathLabel}: ${describe(expected)} !== ${describe(actual)}`);
            return;
        }
        const keys = Array.from(new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])).sort(
            compareCodepoints,
        );
        for (const key of keys) {
            collectDifferences(`${pathLabel}.${key}`, expectedRecord[key], actualRecord[key], out);
        }
        return;
    }

    out.push(`${pathLabel}: ${describe(expected)} !== ${describe(actual)}`);
}

/** Plain UTF-16-code-unit ordering, not `localeCompare` -- matches `fsInventory.ts`'s
 * `compareCodepoints` and this package's stated reason for it: only deterministic error-message
 * ordering is needed here, and locale collation is not deterministic across machines/containers. */
function compareCodepoints(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/** Renders a value for an error message, truncated so one huge digest or text blob cannot blow up
 * the assertion's own error message. */
function describe(value: unknown): string {
    if (value === undefined) return "<undefined>";
    let json: string;
    try {
        json = JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
