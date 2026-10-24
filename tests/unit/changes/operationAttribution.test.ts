import { describe, expect, it } from "vitest";
import { attributeOperationChanges } from "../../../src/changes/operationAttribution";
import { changeFingerprint as hash } from "../../../src/changes/parseDiff";
import { reconcileRanges } from "../../../src/changes/rangeMapping";
import type { RangeSnapshot } from "../../../src/webviews/protocol/changeSelection";

function snapshot(
    base: readonly string[],
    working: readonly string[],
    additions: readonly number[],
    removals: readonly number[] = [],
): RangeSnapshot {
    const baseLines = base.map(hash);
    const workingLines = working.map(hash);
    const anchors = [
        ...removals.map((line) => ({ kind: "remove" as const, line })),
        ...additions.map((line) => ({ kind: "add" as const, line })),
    ].map((anchor, index) => {
        const source = anchor.kind === "add" ? workingLines : baseLines;
        return {
            ...anchor,
            id: `0:${index}`,
            fingerprint: hash(JSON.stringify([anchor.kind, anchor.line, source[anchor.line]])),
            hash: source[anchor.line],
            context: source.slice(Math.max(0, anchor.line - 2), anchor.line + 3),
        };
    });
    return {
        contentId: hash(JSON.stringify([base, working])),
        baseHash: hash(base.join("")),
        workingHash: hash(working.join("")),
        head: "a".repeat(40),
        indexHash: hash("index"),
        baseLines,
        workingLines,
        anchors,
    };
}

function owner(
    result: ReturnType<typeof attributeOperationChanges>,
    snapshot: RangeSnapshot,
    line: number,
) {
    const anchor = snapshot.anchors.find((entry) => entry.kind === "add" && entry.line === line)!;
    return result.ownership.lines[anchor.fingerprint] ?? "A";
}

function explicitOwner(
    result: ReturnType<typeof attributeOperationChanges>,
    snapshot: RangeSnapshot,
    kind: "add" | "remove",
    line: number,
) {
    const anchor = snapshot.anchors.find((entry) => entry.kind === kind && entry.line === line)!;
    return result.ownership.lines[anchor.fingerprint];
}

describe("operation attribution", () => {
    it("preserves pre-existing split owners while assigning only operation anchors", () => {
        const base = Array.from({ length: 12 }, (_, index) => `base ${index}\n`);
        const beforeText = [...base];
        beforeText[2] = "A edit\n";
        beforeText[8] = "B edit\n";
        const before = snapshot(base, beforeText, [2, 8], [2, 8]);
        const previous = reconcileRanges(undefined, before, "A", "C");
        for (const anchor of before.anchors.filter((entry) => entry.line === 8))
            previous.lines[anchor.fingerprint] = "B";
        const afterText = ["operation\n", ...beforeText];
        const after = snapshot(base, afterText, [0, 3, 9], [2, 8]);
        const operation = snapshot(beforeText, afterText, [0]);

        const result = attributeOperationChanges({
            previous,
            before,
            after,
            operation,
            priorFileOwner: "A",
            destinationId: "D",
        });

        expect(result.reviewRequired).toBe(false);
        expect(owner(result, after, 3), "A owner survives an insertion above both blocks").toBe(
            "A",
        );
        expect(owner(result, after, 9), "B owner survives").toBe("B");
        expect(owner(result, after, 0), "only introduced anchor belongs to D").toBe("D");
        expect(result.destinationId).toBe("D");
    });

    it("preserves current owners when resulting bytes match stale history", () => {
        const base = Array.from({ length: 12 }, (_, index) => `base ${index}\n`);
        const beforeText = [...base];
        beforeText[2] = "A edit\n";
        beforeText[8] = "B edit\n";
        const before = snapshot(base, beforeText, [2, 8], [2, 8]);
        const previous = reconcileRanges(undefined, before, "A", "C");
        for (const anchor of before.anchors.filter((entry) => entry.line === 8))
            previous.lines[anchor.fingerprint] = "B";
        const afterText = ["operation\n", ...beforeText];
        const after = snapshot(base, afterText, [0, 3, 9], [2, 8]);
        previous.history = [
            {
                snapshot: after,
                lines: Object.fromEntries(
                    after.anchors
                        .filter(
                            (anchor) =>
                                anchor.line === 9 ||
                                (anchor.kind === "remove" && anchor.line === 8),
                        )
                        .map((anchor) => [anchor.fingerprint, "C"]),
                ),
            },
        ];

        const result = attributeOperationChanges({
            previous,
            before,
            after,
            operation: snapshot(beforeText, afterText, [0]),
            priorFileOwner: "A",
            destinationId: "D",
        });

        expect(result.reviewRequired).toBe(false);
        expect(owner(result, after, 9), "current B owner wins over matching stale history").toBe(
            "B",
        );
        expect(owner(result, after, 0), "introduced operation anchor still belongs to D").toBe("D");
        expect(
            result.ownership.history?.map((entry) => entry.snapshot.contentId),
            "current and prior evidence remain bounded",
        ).toEqual([before.contentId, after.contentId]);
    });

    it("ambiguous repeated context requests review instead of taking ownership", () => {
        const base = ["tail\n"];
        const beforeText = ["same\n", "same\n", "tail\n"];
        const before = snapshot(base, beforeText, [0, 1]);
        const previous = reconcileRanges(undefined, before, "A", "C");
        previous.lines[before.anchors[1].fingerprint] = "B";
        const afterText = ["same\n", "operation\n", "same\n", "tail\n"];
        const after = snapshot(base, afterText, [0, 1, 2]);
        const operation = snapshot(beforeText, afterText, [1]);

        const result = attributeOperationChanges({
            previous,
            before,
            after,
            operation,
            priorFileOwner: "A",
            destinationId: "D",
        });

        expect(result.reviewRequired, "repeated context must fence attribution").toBe(true);
        expect(
            Object.values(result.ownership.lines),
            "D cannot take an ambiguous anchor",
        ).not.toContain("D");
    });

    it("attributes an exact deletion while preserving shifted owners", () => {
        const base = Array.from({ length: 12 }, (_, index) => `base ${index}\n`);
        const beforeText = [...base];
        beforeText[8] = "B edit\n";
        const before = snapshot(base, beforeText, [8], [8]);
        const previous = reconcileRanges(undefined, before, "A", "C");
        for (const anchor of before.anchors) previous.lines[anchor.fingerprint] = "B";
        const afterText = [...beforeText.slice(0, 5), ...beforeText.slice(6)];
        const after = snapshot(base, afterText, [7], [5, 8]);
        const operation = snapshot(beforeText, afterText, [], [5]);

        const result = attributeOperationChanges({
            previous,
            before,
            after,
            operation,
            priorFileOwner: "A",
            destinationId: "D",
        });

        expect(result.reviewRequired).toBe(false);
        expect(owner(result, after, 7), "shifted B owner survives").toBe("B");
        expect(explicitOwner(result, after, "remove", 5)).toBe("D");
    });

    it("preserves CRLF and no-final-newline evidence", () => {
        const base = ["first\r\n", "second\r\n", "tail"];
        const before = snapshot(base, base, []);
        const previous = reconcileRanges(undefined, before, "A", "C");
        const afterText = ["first\r\n", "operation\r\n", "second\r\n", "tail"];
        const after = snapshot(base, afterText, [1]);
        const operation = snapshot(base, afterText, [1]);
        const result = attributeOperationChanges({
            previous,
            before,
            after,
            operation,
            priorFileOwner: "A",
            destinationId: "D",
        });

        expect(result.reviewRequired).toBe(false);
        expect(owner(result, after, 1)).toBe("D");
    });

    it("changed base remains review required without destination ownership", () => {
        const base = ["old base\n", "tail\n"];
        const beforeText = ["local A\n", "tail\n"];
        const before = snapshot(base, beforeText, [0], [0]);
        const previous = reconcileRanges(undefined, before, "A", "C");
        const newBase = ["new base\n", "tail\n"];
        const afterText = ["operation\n", "tail\n"];
        const after = snapshot(newBase, afterText, [0], [0]);
        const operation = snapshot(beforeText, afterText, [0], [0]);
        const result = attributeOperationChanges({
            previous,
            before,
            after,
            operation,
            priorFileOwner: "A",
            destinationId: "D",
        });

        expect(result.reviewRequired).toBe(true);
        expect(Object.values(result.ownership.lines)).not.toContain("D");
    });
});
