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
 *
 * Windows spells one directory three ways, and git picks a different one than Node does (#223).
 * Two independent mismatches, both of which left a real absolute path sitting un-redacted in a
 * committed fixture on the Windows leg while every macOS run looked clean:
 *
 * 1. **8.3 short names.** `os.tmpdir()` on a GitHub Actions Windows runner returns
 *    `C:\Users\RUNNER~1\AppData\Local\Temp`, while git reports the long form,
 *    `C:/Users/runneradmin/AppData/Local/Temp`. `fs.realpathSync` is Node's own JS resolver and
 *    leaves `RUNNER~1` alone; only `fs.realpathSync.native` goes through
 *    `GetFinalPathNameByHandle` and expands it. Both spellings are collected, so neither resolver
 *    has to be the right one.
 * 2. **Separators.** git addresses paths with `/` on every platform; Node hands back `\`. A needle
 *    built from `path.join` therefore cannot match a path that came out of
 *    `git worktree list --porcelain`.
 *
 * The forward-slash variant is added only when the *platform* separator is `\`, never
 * unconditionally: a backslash is a legal character in a POSIX filename, so rewriting one there
 * would fabricate a needle that could redact an unrelated real path. `separator` is a parameter
 * rather than a read of `path.sep` so the Windows branch is reachable from a macOS run -- see
 * `tests/unit/fixtures/placeholderCanonicalization.test.ts`.
 *
 * 3. **Percent-encoding.** git stores a local remote as a `file://` URL and percent-encodes the
 *    path inside it, so the 8.3 short name reaches `.git/config` as
 *    `file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/...` -- `~` written as `%7E`. None of the
 *    three spellings above match that, so the whole URL survived normalization and the two sides
 *    of a rehydration comparison differed by their random workspace segment. Measured on run
 *    32650798689: `gitDirState.data.common[3:relativePath=config].digest` mismatched while every
 *    other captured field agreed.
 *
 * The encoded variant is added unconditionally rather than gated on the separator: on POSIX the
 * encoding is a no-op for ordinary paths (the Set dedupes it away) and a genuine improvement for
 * one containing a space, which git encodes as `%20` on every platform.
 *
 * 4. **JSON escaping.** A captured artifact is not always raw text. The shelf journal
 *    (`journals/<SHELF-ID>.json`) stores absolute paths inside a JSON string, so every separator
 *    arrives DOUBLED -- `C:\\Users\\RUNNER~1\\...` -- and a single-backslash needle cannot match
 *    it. Same run: `pathProgress.untracked.txt.target` and `.recoveryPath` both survived intact,
 *    carrying the random workspace segment that made two seeded copies compare unequal.
 *
 * The doubled variant is gated on the separator for the same reason the forward-slash one is: a
 * backslash is legal in a POSIX filename, so doubling one there would fabricate a needle.
 *
 * Deleted roots (#223, same run): a snapshot is often normalized AFTER the directory it describes
 * is gone -- `restoreFidelity` compares a pre-restore snapshot against a post-restore one, and the
 * pre-restore workspace no longer exists by then. A bare `realpath` throws there, and falling back
 * to the literal candidate silently drops the long-name spelling, which is the ONE spelling git's
 * own output uses. {@link realpathOrSelf} therefore resolves the longest ancestor that still exists
 * and re-appends the rest, so a torn-down leaf still contributes its canonical prefix.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

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
 * nothing along the path resolves -- normalization must stay usable when called before the
 * directory exists (e.g. a not-yet-created `profileDir`) or against a purely in-memory, fabricated
 * value in a test.
 *
 * A candidate whose LEAF is gone but whose ancestors survive is resolved rather than abandoned: the
 * longest existing ancestor is realpath'd and the unresolvable remainder is re-appended. On Windows
 * that recovers the long-name prefix (`C:\Users\runneradmin\...`) for a workspace that has already
 * been torn down, which is the only spelling git's own output ever uses. Without it, a snapshot
 * normalized after its directory was removed keeps a real absolute path in the artifact.
 */
function realpathOrSelf(candidate: string, resolve: (path: string) => string): string {
    let head = candidate;
    let suffix = "";
    for (;;) {
        try {
            const resolved = resolve(head);
            return suffix.length === 0 ? resolved : join(resolved, suffix);
        } catch {
            const parent = dirname(head);
            // `dirname` is a fixed point at the filesystem root, so that is one terminating case:
            // nothing along the whole path resolved and the literal candidate is all there is.
            //
            // `"."` is the other, and it is the one that matters for a path written in the OTHER
            // platform's separator -- POSIX `dirname` sees no `/` in `C:\Users\...` and returns
            // `"."`. Resolving that would succeed and graft the CWD onto the front of a Windows
            // path, fabricating a needle that describes no real location. Only true ANCESTORS of
            // the candidate may be resolved.
            if (parent === head || parent === ".") return candidate;
            suffix = suffix.length === 0 ? basename(head) : join(basename(head), suffix);
            head = parent;
        }
    }
}

/**
 * Characters git leaves alone when percent-encoding a path into a `file://` URL. Everything else --
 * notably the `~` that makes an 8.3 short name, and a space -- is encoded, so a needle built from
 * the raw path cannot match what lands in `.git/config`.
 */
const UNENCODED_IN_GIT_URL = /[A-Za-z0-9._:/-]/;

/** Percent-encodes a path the way git writes one into a `file://` remote URL. */
function percentEncodePath(spelling: string): string {
    let encoded = "";
    for (const character of spelling) {
        if (UNENCODED_IN_GIT_URL.test(character)) {
            encoded += character;
            continue;
        }
        for (const byte of new TextEncoder().encode(character)) {
            encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        }
    }
    return encoded;
}

/**
 * Every spelling of one root -- literal, both realpath'd forms, their forward-slash variants on
 * Windows, and the percent-encoded form of each -- mapped to the same placeholder. See the module
 * doc comment's "Realpath duality" and Windows sections for why each is needed.
 */
function spellingsFor(
    root: string,
    placeholder: string,
    separator: string,
): readonly PlaceholderReplacement[] {
    if (root.length === 0) return [];
    const spellings = new Set([
        root,
        realpathOrSelf(root, realpathSync),
        realpathOrSelf(root, realpathSync.native),
    ]);
    if (separator === "\\") {
        for (const spelling of [...spellings]) spellings.add(spelling.split("\\").join("/"));
        // AFTER the forward-slash pass, never before: doubling first would turn `C:\Users` into
        // `C:\\Users` and then into `C://Users`, a needle matching nothing.
        for (const spelling of [...spellings]) spellings.add(spelling.split("\\").join("\\\\"));
    }
    // After the separator passes, so the forward-slash spellings git actually emits get encoded too.
    for (const spelling of [...spellings]) spellings.add(percentEncodePath(spelling));
    return Array.from(spellings, (spelling) => [spelling, placeholder] as const);
}

/**
 * Builds the full, longest-needle-first ordered replacement list for a set of roots. Longest-first
 * so a root nested inside another root -- or a root's realpath'd spelling nested inside its own
 * literal spelling, or vice versa -- is never partially replaced.
 */
export function buildPlaceholderReplacements(
    roots: PlaceholderRoots,
    separator: string = sep,
): readonly PlaceholderReplacement[] {
    return [
        ...spellingsFor(roots.root, "<ROOT>", separator),
        ...spellingsFor(roots.originRoot, "<ORIGIN>", separator),
        ...spellingsFor(roots.profileDir, "<PROFILE>", separator),
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
