import type { RangeSnapshot } from "../webviews/protocol/changeSelection";
import { mapLines, reconcileRanges, type HydratedChangeOwnership } from "./rangeMapping";

/** Complete immutable evidence needed to attribute one operation without reading Git or metadata. */
export interface OperationAttributionInput {
    readonly previous: HydratedChangeOwnership;
    readonly before: RangeSnapshot;
    readonly after: RangeSnapshot;
    readonly operation: RangeSnapshot;
    readonly priorFileOwner: string;
    readonly destinationId: string;
}

/** Conservative attribution result; the destination intent survives review-required outcomes. */
export interface OperationAttributionResult {
    readonly ownership: HydratedChangeOwnership;
    readonly reviewRequired: boolean;
    readonly destinationId: string;
}

/** Maps old owners and assigns only anchors proven to come from the accepted operation result. */
export function attributeOperationChanges(
    input: OperationAttributionInput,
): OperationAttributionResult {
    // The captured `before` snapshot is authoritative for this operation. Historical content
    // matches remain useful evidence, but cannot replace its current owners during reconciliation.
    const current = { ...input.previous, history: undefined };
    const reconciled = reconcileRanges(
        current,
        input.after,
        input.priorFileOwner,
        input.priorFileOwner,
    );
    const ownership = {
        ...reconciled,
        history:
            reconciled === current
                ? input.previous.history
                : input.previous.tracking
                  ? [
                        { snapshot: input.previous.tracking, lines: input.previous.lines },
                        ...(input.previous.history ?? []),
                    ].slice(0, 2)
                  : input.previous.history,
    };
    const introduced = provenIntroducedAnchors(input);
    if (ownership.stale || !introduced) {
        return { ownership, reviewRequired: true, destinationId: input.destinationId };
    }
    const lines = { ...ownership.lines };
    for (const anchor of introduced) lines[anchor.fingerprint] = input.destinationId;
    return {
        ownership: { ...ownership, lines },
        reviewRequired: false,
        destinationId: input.destinationId,
    };
}

/** Proves operation anchors against exact accepted before/after bytes and unique coordinates. */
function provenIntroducedAnchors(
    input: OperationAttributionInput,
): RangeSnapshot["anchors"] | undefined {
    if (
        input.previous.tracking?.contentId !== input.before.contentId ||
        input.before.baseHash !== input.after.baseHash ||
        input.operation.baseHash !== input.before.workingHash ||
        input.operation.workingHash !== input.after.workingHash ||
        !sameLines(input.operation.baseLines, input.before.workingLines) ||
        !sameLines(input.operation.workingLines, input.after.workingLines)
    )
        return undefined;

    const result: RangeSnapshot["anchors"] = [];
    const afterAnchors = uniqueAnchors(input.after);
    const beforeAdditions = new Set(
        input.before.anchors.filter((anchor) => anchor.kind === "add").map((anchor) => anchor.line),
    );
    const beforeToBase = new Map<number, number>();
    for (const [baseLine, workingLine] of mapLines(
        input.before.baseLines,
        input.before.workingLines,
    ))
        beforeToBase.set(workingLine, baseLine);
    for (const operationAnchor of input.operation.anchors) {
        let afterAnchor: RangeSnapshot["anchors"][number] | undefined;
        if (operationAnchor.kind === "add") {
            afterAnchor = afterAnchors.get(anchorKey(operationAnchor));
        } else {
            if (beforeAdditions.has(operationAnchor.line)) return undefined;
            const baseLine = beforeToBase.get(operationAnchor.line);
            if (baseLine === undefined) return undefined;
            afterAnchor = afterAnchors.get(
                anchorKey({ ...operationAnchor, kind: "remove", line: baseLine }),
            );
        }
        if (!afterAnchor) return undefined;
        result.push(afterAnchor);
    }
    return result;
}

/** Indexes each unique resulting anchor once; duplicate evidence remains unprovable. */
function uniqueAnchors(
    snapshot: RangeSnapshot,
): Map<string, RangeSnapshot["anchors"][number] | undefined> {
    const result = new Map<string, RangeSnapshot["anchors"][number] | undefined>();
    for (const anchor of snapshot.anchors) {
        const key = anchorKey(anchor);
        result.set(key, result.has(key) ? undefined : anchor);
    }
    return result;
}

/** Kind, coordinate, and content hash are the complete anchor lookup key. */
function anchorKey(anchor: Pick<RangeSnapshot["anchors"][number], "kind" | "line" | "hash">) {
    return `${anchor.kind}:${anchor.line}:${anchor.hash}`;
}

/** Exact line-hash equality preserves CRLF and missing-final-newline distinctions. */
function sameLines(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((line, index) => line === right[index]);
}
