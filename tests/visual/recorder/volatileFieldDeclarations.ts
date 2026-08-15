/**
 * Declared-volatile-field canonicalization (Phase 2b deliverable 2). PLAN.md step 12 asks for
 * volatile non-path values -- ISO timestamps, UUIDs -- to be canonicalized "driven by an EXPLICIT
 * declared list of what is volatile, not by a heuristic that guesses which strings look like
 * dates." A heuristic silently rewrites a legitimate commit message that happens to contain a
 * date; a declared list instead fails LOUDLY (the two recordings stay observably different) the
 * moment a new volatile field appears undeclared -- see
 * `tests/unit/visual/recorder/canonicalizeCapturedMessages.test.ts`'s "fail loudly" suite for the
 * oracle that proves it.
 *
 * A declaration's `path` is a sequence of object-key segments, read relative to the value being
 * canonicalized (a captured message's `message` payload). The wildcard segment `"*"` matches every
 * element of an array at that position, so one declaration reaches every item of a list without
 * the caller having to know its length up front.
 */

/**
 * One segment of a {@link VolatileFieldDeclaration} path: an object key, or `"*"` for "every array
 * element here". Not exported -- callers only ever need `readonly string[]` (see
 * `VolatileFieldDeclaration.path`); this alias exists purely to name the concept in this module's
 * own signatures.
 */
type VolatileFieldPathSegment = string;

/** One declared volatile field: where it lives, and the stable placeholder it becomes. */
export interface VolatileFieldDeclaration {
    readonly path: readonly VolatileFieldPathSegment[];
    readonly placeholder: string;
}

/**
 * Rewrites the value reached by following `path` from `value` to `placeholder`, rebuilding every
 * container along the way rather than mutating it. A path segment that does not resolve -- a
 * missing object key, or `"*"` applied to something that is not an array -- leaves `value`
 * unchanged at that point instead of throwing, so one declaration cannot make canonicalization
 * fail just because a particular message shape does not carry that field.
 */
function replaceAtPath(
    value: unknown,
    path: readonly VolatileFieldPathSegment[],
    placeholder: string,
): unknown {
    if (path.length === 0) {
        return placeholder;
    }
    const [head, ...rest] = path;

    if (head === "*") {
        if (!Array.isArray(value)) return value;
        return value.map((item) => replaceAtPath(item, rest, placeholder));
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }
    const record = value as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, head)) {
        return value;
    }
    return { ...record, [head]: replaceAtPath(record[head], rest, placeholder) };
}

/**
 * Applies every declared volatile-field rewrite to `value`, in declaration order. Only paths named
 * in `declarations` are ever touched -- this is the whole point of the declared-list design over a
 * heuristic, and is what {@link replaceAtPath}'s exact-path matching guarantees.
 */
export function applyVolatileFieldDeclarations(
    value: unknown,
    declarations: readonly VolatileFieldDeclaration[],
): unknown {
    return declarations.reduce(
        (acc, declaration) => replaceAtPath(acc, declaration.path, declaration.placeholder),
        value,
    );
}
