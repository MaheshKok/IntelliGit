import { changeFingerprint } from "./parseDiff";
import type { PartialFileSnapshot } from "../git/partialSnapshot";
import type {
    ChangeOwnership,
    ChangelistState,
    RangeSnapshot,
} from "../webviews/protocol/changeSelection";

/** Complete evidence exists only inside a reconciliation transaction or legacy migration. */
export type HydratedChangeOwnership = Omit<ChangeOwnership, "tracking" | "history"> & {
    tracking?: RangeSnapshot;
    history?: { snapshot: RangeSnapshot; lines: Record<string, string> }[];
};

/** Legacy inline metadata retained only for lossless migration and disconnected workspace saves. */
export type HydratedChangelistState = Omit<ChangelistState, "changes"> & {
    changes: Record<string, HydratedChangeOwnership>;
};

/** Captures coordinates plus cryptographic content/context evidence from a host-validated diff. */
export function rangeSnapshot(
    snapshot: Pick<PartialFileSnapshot, "view" | "working" | "contentId" | "head" | "indexHash">,
): RangeSnapshot {
    const baseLines = hashes(snapshot.view.base);
    const workingLines = hashes(snapshot.working);
    return {
        contentId: snapshot.contentId,
        baseHash: changeFingerprint(snapshot.view.base),
        workingHash: changeFingerprint(snapshot.working),
        head: snapshot.head,
        indexHash: snapshot.indexHash,
        baseLines,
        workingLines,
        anchors: snapshot.view.blocks.flatMap((block) =>
            block.lines.flatMap((line) => {
                if (line.kind === "context") return [];
                const position = (line.kind === "add" ? line.newLine : line.oldLine)! - 1;
                const source = line.kind === "add" ? workingLines : baseLines;
                return [
                    {
                        id: line.id,
                        fingerprint: line.fingerprint,
                        kind: line.kind,
                        line: position,
                        hash: changeFingerprint(line.text),
                        context: source.slice(Math.max(0, position - 2), position + 3),
                    },
                ];
            }),
        ),
    };
}

/** Newline-sensitive hashes retain CRLF and missing-final-newline distinctions. */
function hashes(text: string): string[] {
    return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map(changeFingerprint);
}

/**
 * Maps only unique content/context matches whose order is unambiguous. Repeated or
 * moved text is deliberately left unmapped; coordinates alone never establish identity.
 */
export function mapLines(before: readonly string[], after: readonly string[]): Map<number, number> {
    if (before.length === after.length && before.every((hash, i) => hash === after[i]))
        return new Map(before.map((_, i) => [i, i]));
    const matches = new Map<number, number>();
    for (const radius of [0, 2]) {
        const oldKeys = uniqueContexts(before, radius);
        const newKeys = uniqueContexts(after, radius);
        for (const [key, oldLine] of oldKeys) {
            const newLine = newKeys.get(key);
            if (oldLine >= 0 && newLine !== undefined && newLine >= 0)
                matches.set(oldLine, newLine);
        }
    }
    const ordered = [...matches].sort((a, b) => a[0] - b[0]);
    // Reject every member of a crossing, rather than choosing an arbitrary longest subsequence.
    let maximum = -1;
    const invalid = new Set<number>();
    for (const [oldLine, newLine] of ordered) {
        if (newLine <= maximum) invalid.add(oldLine);
        maximum = Math.max(maximum, newLine);
    }
    let minimum = after.length;
    for (const [oldLine, newLine] of [...ordered].reverse()) {
        if (newLine >= minimum) invalid.add(oldLine);
        minimum = Math.min(minimum, newLine);
    }
    for (const oldLine of invalid) matches.delete(oldLine);
    return matches;
}

/** A repeated context is explicitly ambiguous, including repeated blank lines. */
function uniqueContexts(lines: readonly string[], radius: number): Map<string, number> {
    const result = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
        const key = lines.slice(Math.max(0, i - radius), i + radius + 1).join(":");
        result.set(key, result.has(key) ? -1 : i);
    }
    return result;
}

/**
 * Rebases ownership and explicit inclusion independently. Unproved overlap retains the old
 * evidence and fences the entire file; it can never become an implicit whole-file selection.
 */
export function reconcileRanges(
    previous: HydratedChangeOwnership | undefined,
    next: RangeSnapshot,
    fallback: string,
    active: string,
): HydratedChangeOwnership {
    if (previous?.tracking && previous.contentId === next.contentId && !previous.stale)
        return previous;
    const old = previous?.tracking;
    if (!old) return initializeRanges(previous, next);
    if (previous.stale) return refused(previous, next);
    const historical = previous.history?.find(
        (entry) => entry.snapshot.contentId === next.contentId,
    );
    const source = historical?.snapshot ?? old;
    const owners = historical?.lines ?? previous.lines;
    const { lines, ids, ambiguous } = matchRanges(source, next, owners, fallback, active);
    if (ambiguous) return refused(previous, next);
    return {
        ...previous,
        contentId: next.contentId,
        lines,
        stale: false,
        totalChanges: next.anchors.length,
        tracking: next,
        history: [{ snapshot: old, lines: previous.lines }, ...(previous.history ?? [])].slice(
            0,
            2,
        ),
        selections: mapSelections(previous, next, historical ? new Map() : ids),
    };
}

/** Match exact anchors first, then resolve only single-owner insertion gaps. */
function matchRanges(
    source: RangeSnapshot,
    next: RangeSnapshot,
    owners: Readonly<Record<string, string>>,
    fallback: string,
    active: string,
) {
    const baseMap = mapLines(source.baseLines, next.baseLines);
    const workMap = mapLines(source.workingLines, next.workingLines);
    const candidates = new Map<string, RangeSnapshot["anchors"][number]>();
    for (const anchor of source.anchors) {
        const line = (anchor.kind === "add" ? workMap : baseMap).get(anchor.line);
        if (line !== undefined) candidates.set(`${anchor.kind}:${line}`, anchor);
    }
    const lines: Record<string, string> = {};
    const ids = new Map<string, string>();
    const boundaries = [...workMap].sort((a, b) => a[1] - b[1]);
    const insertions = new Map(
        source.anchors
            .filter((anchor) => anchor.kind === "add")
            .map((anchor) => [anchor.line, anchor]),
    );
    const gaps = new Map<string, string | undefined>();
    let ambiguous = source.baseHash !== next.baseHash && source.workingHash !== next.workingHash;
    for (const anchor of next.anchors) {
        const prior = candidates.get(`${anchor.kind}:${anchor.line}`);
        let owner: string | undefined;
        if (prior && prior.hash === anchor.hash) {
            owner = owners[prior.fingerprint] ?? fallback;
            ids.set(prior.id, anchor.id);
        } else {
            owner = newOwner(
                anchor,
                source,
                next,
                boundaries,
                insertions,
                gaps,
                owners,
                fallback,
                active,
            );
        }
        if (owner === undefined) ambiguous = true;
        else if (owner !== fallback) lines[anchor.fingerprint] = owner;
    }
    return { lines, ids, ambiguous };
}

/** Bootstrap only an exact legacy content fence; mismatched migration records remain reviewable. */
function initializeRanges(
    previous: HydratedChangeOwnership | undefined,
    next: RangeSnapshot,
): HydratedChangeOwnership {
    if (previous && (previous.stale || previous.contentId !== next.contentId))
        return refused(previous, next);
    return {
        ...previous,
        contentId: next.contentId,
        lines: previous?.lines ?? {},
        totalChanges: next.anchors.length,
        tracking: next,
    };
}

/** Resolve edits within one owned insertion; mixed ownership or repeated context requires review. */
function newOwner(
    anchor: RangeSnapshot["anchors"][number],
    before: RangeSnapshot,
    after: RangeSnapshot,
    boundaries: readonly [number, number][],
    insertions: ReadonlyMap<number, RangeSnapshot["anchors"][number]>,
    gaps: Map<string, string | undefined>,
    owners: Readonly<Record<string, string>>,
    fallback: string,
    active: string,
): string | undefined {
    if (before.baseHash !== after.baseHash) return undefined;
    if (anchor.kind === "remove") return active;
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (boundaries[middle][1] < anchor.line) low = middle + 1;
        else high = middle;
    }
    const start = boundaries[low - 1]?.[0] ?? -1;
    const end = boundaries[low]?.[0] ?? before.workingLines.length;
    const key = `${start}:${end}`;
    if (gaps.has(key)) return gaps.get(key);
    const choices = new Set<string>();
    let changed = 0;
    for (let line = start + 1; line < end; line++) {
        const old = insertions.get(line);
        if (!old) continue;
        changed++;
        choices.add(owners[old.fingerprint] ?? fallback);
    }
    const owner =
        changed === 0
            ? active
            : changed === end - start - 1 && choices.size === 1
              ? [...choices][0]
              : undefined;
    gaps.set(key, owner);
    return owner;
}

/** An explicit empty selection remains empty; nonempty selections require an exact bijection. */
function mapSelections(
    previous: HydratedChangeOwnership,
    next: RangeSnapshot,
    ids: ReadonlyMap<string, string>,
): HydratedChangeOwnership["selections"] {
    if (!previous.selections) return undefined;
    return Object.fromEntries(
        Object.entries(previous.selections).map(([scope, selection]) => {
            if (!selection.lineIds.length && !selection.reviewRequired)
                return [
                    scope,
                    { ...selection, contentId: next.contentId, total: next.anchors.length },
                ];
            const mapped = selection.lineIds.map((id) => ids.get(id));
            if (
                selection.reviewRequired ||
                selection.contentId !== previous.contentId ||
                mapped.some((id) => id === undefined)
            )
                return [scope, { ...selection, reviewRequired: true }];
            return [
                scope,
                {
                    contentId: next.contentId,
                    total: next.anchors.length,
                    lineIds: mapped as string[],
                },
            ];
        }),
    );
}

/** Preserve original anchors and choices for inspection instead of guessing ownership. */
function refused(previous: HydratedChangeOwnership, next: RangeSnapshot): HydratedChangeOwnership {
    if (previous.stale && previous.contentId === next.contentId && previous.tracking)
        return previous;
    return {
        ...previous,
        contentId: next.contentId,
        totalChanges: next.anchors.length,
        stale: true,
        tracking: next,
        history: previous.tracking
            ? [
                  { snapshot: previous.tracking, lines: previous.lines },
                  ...(previous.history ?? []),
              ].slice(0, 2)
            : previous.history,
    };
}
