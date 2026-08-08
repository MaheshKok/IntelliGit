/**
 * The shared placeholder-substitution core for PLAN.md's "canonical placeholders `<ROOT>`,
 * `<ORIGIN>`, `<PROFILE>`" contract (Phase 1 step 8), extracted so there is exactly ONE
 * implementation of this logic in the repository. `snapshotNormalize.ts` (Phase 1's canonical
 * snapshot normalizer) and the Phase 2 recorder's `canonicalizeCapturedMessages.ts` both consume
 * this module rather than each re-deriving the substitution rules -- Phase 2's recorder needs "the
 * same canonicalization" PLAN.md step 12 requires, and a second hand-rolled copy would drift the
 * moment one side changed a rule the other didn't know to mirror.
 *
 * Nothing in this module is snapshot-shaped: {@link normalizeUnknownDeep} deep-walks arbitrary
 * JSON-shaped data (objects, arrays, nested strings, and the scalar leaves alongside them), which
 * is exactly what a recorded webview protocol payload is. Everything here only ever returns a new,
 * rewritten value -- nothing here mutates its input or touches the filesystem (beyond resolving a
 * realpath for the ordering fix below, which is a read, never a write).
 *
 * Longest-needle-first ordering: `profileDir` can be nested inside `root` (or either root's
 * realpath'd spelling can be nested inside its own literal spelling, or vice versa). Sorting
 * needles by descending length before substituting is what stops a nested root being partially
 * replaced by a shorter enclosing one -- e.g. `<ROOT>/profile/...` instead of the correct
 * `<PROFILE>/...`.
 *
 * Realpath duality (see `snapshotNormalize.ts`'s original module doc for the full empirical
 * finding): `git worktree list --porcelain` always reports the *realpath'd* form of the primary
 * worktree's own path, so a needle list built from only the literal spelling a caller passed in
 * leaves the realpath'd spelling's OS-specific prefix (e.g. `/private` on macOS) stitched onto the
 * placeholder instead of the clean form the contract promises. Every root's needle list therefore
 * includes both its literal spelling and its realpath'd spelling, when they differ and the path
 * exists.
 */

import { realpathSync } from "node:fs";

/** The three concrete-path roots a copy carries after live rehydration (PLAN.md step 8). */
export interface PlaceholderRoots {
    readonly root: string;
    readonly originRoot: string;
    readonly profileDir: string;
}

/** One ordered substitution rule: replace every occurrence of `needle` with `placeholder`. */
export type PlaceholderReplacement = readonly [needle: string, placeholder: string];

/**
 * Resolves `candidate` to its realpath'd spelling, falling back to the literal candidate whenever
 * it does not exist yet or realpath otherwise fails -- normalization must stay usable even when
 * called before the directory exists (e.g. a not-yet-created `profileDir`) or against a purely
 * in-memory, fabricated value in a test.
 */
function realpathOrSelf(candidate: string): string {
    try {
        return realpathSync(candidate);
    } catch {
        return candidate;
    }
}

/**
 * Both spellings of one root -- literal and realpath'd -- mapped to the same placeholder. See the
 * module doc comment's "Realpath duality" section for why both are needed.
 */
function spellingsFor(root: string, placeholder: string): readonly PlaceholderReplacement[] {
    if (root.length === 0) return [];
    const realRoot = realpathOrSelf(root);
    const spellings = new Set([root, realRoot]);
    return Array.from(spellings, (spelling) => [spelling, placeholder] as const);
}

/**
 * Builds the full, longest-needle-first ordered replacement list for a set of roots. Longest-first
 * so a root nested inside another root -- or a root's realpath'd spelling nested inside its own
 * literal spelling, or vice versa -- is never partially replaced.
 */
export function buildPlaceholderReplacements(
    roots: PlaceholderRoots,
): readonly PlaceholderReplacement[] {
    return [
        ...spellingsFor(roots.root, "<ROOT>"),
        ...spellingsFor(roots.originRoot, "<ORIGIN>"),
        ...spellingsFor(roots.profileDir, "<PROFILE>"),
    ].sort(([a], [b]) => b.length - a.length);
}

/** Applies every ordered replacement to one string, left to right. */
export function normalizeString(
    value: string,
    replacements: readonly PlaceholderReplacement[],
): string {
    let result = value;
    for (const [needle, placeholder] of replacements) {
        result = result.split(needle).join(placeholder);
    }
    return result;
}

/**
 * Deeply normalizes arbitrary JSON-shaped data: strings are rewritten via {@link normalizeString},
 * arrays and plain objects are walked recursively and rebuilt (never mutated), and every other
 * value (number, boolean, `null`, `undefined`) is returned unchanged. This is the function that
 * makes the core usable for a recorded protocol payload's shape, not only `WorkspaceSnapshot`.
 *
 * Object KEYS are normalized alongside values, because a key is a perfectly ordinary place for an
 * absolute path to live: `UndockedViewProvider.getCommitDraftStorageKey`
 * (`src/views/UndockedViewProvider.ts`) stores the undocked commit draft under
 * `intelligit.commitDraft:<absolute repository root>`, and that Memento content is exactly what a
 * snapshot's `durableState` section captures and what a recorded payload can echo back. A
 * value-only walker leaves the real path sitting in the committed artifact while every string it
 * did rewrite looks clean -- the silent-leak shape this whole canonicalization layer exists to
 * prevent.
 *
 * A key collision throws rather than resolving. `Object.fromEntries` keeps the last of two equal
 * keys, so two distinct raw keys collapsing to one placeholder would silently drop a captured
 * entry -- a fixture that is quietly missing data is worse than one that fails to record.
 */
export function normalizeUnknownDeep(
    value: unknown,
    replacements: readonly PlaceholderReplacement[],
): unknown {
    if (typeof value === "string") return normalizeString(value, replacements);
    if (Array.isArray(value)) return value.map((item) => normalizeUnknownDeep(item, replacements));
    if (value !== null && typeof value === "object") {
        const normalized = new Map<string, unknown>();
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            const normalizedKey = normalizeString(key, replacements);
            if (normalized.has(normalizedKey)) {
                throw new Error(
                    `Placeholder canonicalization collision: two distinct keys both normalize to ` +
                        `"${normalizedKey}". Keeping either one would silently drop the other.`,
                );
            }
            normalized.set(normalizedKey, normalizeUnknownDeep(item, replacements));
        }
        return Object.fromEntries(normalized);
    }
    return value;
}
