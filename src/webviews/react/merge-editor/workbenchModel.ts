import { StateEffect, StateField, type ChangeDesc, type Text } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import type { MergeEditorData, ConflictSegment } from "../../../mergeEditor/conflictParser";
import { getResultLines, isTrueConflict } from "./mergeState";

/** Anchors each original merge range into the current editable result document. */
export interface WorkbenchHunk {
    id: number;
    from: number;
    to: number;
    oursFrom: number;
    oursTo: number;
    theirsFrom: number;
    theirsTo: number;
    resolved: boolean;
    conflict: boolean;
    segment: ConflictSegment;
}

/** Uses the existing merge renderer's conflict and one-sided change palette. */
export function workbenchChangeClass(hunk: WorkbenchHunk): string {
    if (hunk.conflict && hunk.resolved) return "merge-range-resolved";
    if (hunk.conflict) return "merge-range-pending";
    return hunk.segment.baseLines.length === 0 ? "merge-range-insertion" : "merge-range-pending";
}

/** Complete initial result and immutable side offsets derived from the established merge grouping. */
export function buildWorkbenchDocument(data: MergeEditorData): {
    content: string;
    hunks: WorkbenchHunk[];
} {
    let content = "";
    let oursOffset = 0;
    let theirsOffset = 0;
    const hunks: WorkbenchHunk[] = [];
    for (const segment of data.segments) {
        if (segment.type === "common") {
            const text = linesText(segment.lines);
            content += text;
            oursOffset += text.length;
            theirsOffset += text.length;
        } else {
            const ours = linesText(segment.oursLines);
            const theirs = linesText(segment.theirsLines);
            const result = linesText(getResultLines(segment, undefined));
            const conflict = isTrueConflict(segment);
            hunks.push({
                id: segment.id,
                from: content.length,
                to: content.length + result.length,
                oursFrom: oursOffset,
                oursTo: oursOffset + ours.length,
                theirsFrom: theirsOffset,
                theirsTo: theirsOffset + theirs.length,
                resolved: !conflict,
                conflict,
                segment,
            });
            content += result;
            oursOffset += ours.length;
            theirsOffset += theirs.length;
        }
    }
    if (!data.hasTrailingNewline && content.endsWith("\n")) {
        content = content.slice(0, -1);
        for (const hunk of hunks) hunk.to = Math.min(hunk.to, content.length);
    }
    return { content, hunks };
}

/** Normalizes logical lines for editor transactions; output EOL is restored only at Apply. */
export function linesText(lines: readonly string[]): string {
    return lines.length ? lines.join("\n") + "\n" : "";
}

/** Maps decisions with edits, including insertions into formerly empty conflict ranges. */
function mapHunks(hunks: readonly WorkbenchHunk[], changes: ChangeDesc): WorkbenchHunk[] {
    let previous = 0;
    return hunks.map((hunk) => {
        const from = Math.max(previous, changes.mapPos(hunk.from, -1));
        const to = Math.max(from, changes.mapPos(hunk.to, hunk.from === hunk.to ? 1 : -1));
        previous = to;
        return {
            ...hunk,
            from,
            to,
        };
    });
}

/** Restores both decisions and range geometry as part of native CodeMirror undo/redo. */
export const replaceHunks = StateEffect.define<readonly WorkbenchHunk[]>({ map: mapHunks });

/** Keeps conflict ranges mapped to the live document, never to a stale parsed segment index. */
export const workbenchHunks = StateField.define<readonly WorkbenchHunk[]>({
    create: () => [],
    update(value, transaction) {
        let next = transaction.docChanged ? mapHunks(value, transaction.changes) : value;
        for (const effect of transaction.effects) if (effect.is(replaceHunks)) next = effect.value;
        return next;
    },
});

/** Decisions and manual edits use the same reversible transaction boundary. */
export const workbenchHistory = invertedEffects.of((transaction) =>
    transaction.docChanged || transaction.effects.some((effect) => effect.is(replaceHunks))
        ? [replaceHunks.of(transaction.startState.field(workbenchHunks))]
        : [],
);

/** Bounds a stored draft's offsets and identities against the current immutable conflict input. */
export function restoreDraftHunks(
    original: readonly WorkbenchHunk[],
    value: unknown,
    length: number,
): WorkbenchHunk[] | null {
    if (!Array.isArray(value) || value.length !== original.length) return null;
    const result: WorkbenchHunk[] = [];
    let previous = 0;
    for (const [index, source] of value.entries()) {
        if (!source || typeof source !== "object") return null;
        const entry = source as Record<string, unknown>;
        if (
            entry.id !== original[index].id ||
            !Number.isSafeInteger(entry.from) ||
            !Number.isSafeInteger(entry.to) ||
            typeof entry.resolved !== "boolean" ||
            typeof entry.from !== "number" ||
            typeof entry.to !== "number" ||
            entry.from < previous ||
            entry.to < entry.from ||
            entry.to > length
        )
            return null;
        result.push({
            ...original[index],
            from: entry.from,
            to: entry.to,
            resolved: entry.resolved,
        });
        previous = entry.to;
    }
    return result;
}

/** Converts normalized editor text back to the captured source line endings. */
export function resultContent(document: Text, data: MergeEditorData): string {
    return document.toString().replace(/\n/g, data.eol ?? "\n");
}
