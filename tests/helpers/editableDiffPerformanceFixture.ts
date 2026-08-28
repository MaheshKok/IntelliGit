import { computeDiffSegments } from "../../src/diff/diffSegments";
import type { DiffViewerData } from "../../src/webviews/protocol/diffViewerTypes";

export interface EditableDiffPerformanceFixture {
    readonly leftText: string;
    readonly rightText: string;
    readonly data: DiffViewerData;
}

/** Builds the stable large editable-diff workload used by integration and E2E performance proofs. */
export function buildEditableDiffPerformanceFixture(): EditableDiffPerformanceFixture {
    const leftLines = Array.from(
        { length: 2_300 },
        (_, index) => "const value_" + index + " = " + index + ";",
    );
    leftLines[0] = 'const horizontal_sentinel = "' + "x".repeat(200) + '";';
    const rightLines = leftLines.map((line, index) =>
        index % 12 === 6 ? line + " // working tree" : line,
    );
    const leftText = leftLines.join("\n") + "\n";
    const rightText = rightLines.join("\n") + "\n";
    return {
        leftText,
        rightText,
        data: {
            path: "src/editable-performance.ts",
            leftLabel: "HEAD",
            rightLabel: "Working tree",
            languageId: "typescript",
            ...computeDiffSegments(leftText, rightText),
            editablePane: "right",
            editableText: rightText,
            documentVersion: 1,
            editableReseedToken: 0,
            ignoreWhitespace: false,
        },
    };
}
