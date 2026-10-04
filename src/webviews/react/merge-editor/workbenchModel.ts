import {
    StateEffect,
    StateField,
    type ChangeDesc,
    type EditorState,
    type Extension,
    type Text,
    type TransactionSpec,
} from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import type { MergeEditorData, ConflictSegment } from "../../../mergeEditor/conflictParser";
import { getResultLines, isTrueConflict } from "./mergeState";

/** Available replacements for a merge hunk. */
export type MergeChoice = "ours" | "theirs" | "both" | "both-reversed" | "base" | "none";

/** Segment grouping and whitespace policy loaded from the host. */
export interface Grouping {
    ignoreWhitespace: boolean;
    segments: MergeEditorData["segments"];
}

/** Holds the host's grouping for this editor snapshot. */
export const groupingField = StateField.define<Grouping>({
    create: () => {
        throw new Error("groupingField needs init(data)");
    },
    update: (value) => value,
});

/** Initializes grouping from the loaded host data, including its whitespace policy. */
export function groupingInit(data: MergeEditorData): Extension {
    return groupingField.init(() => ({
        ignoreWhitespace: data.diffOptions?.ignoreWhitespace === true,
        segments: data.segments,
    }));
}

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
    decision?: MergeChoice;
    edited: boolean;
    dismissed: { ours: boolean; theirs: boolean };
    conflict: boolean;
    segment: ConflictSegment;
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
                edited: false,
                dismissed: { ours: false, theirs: false },
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
function linesText(lines: readonly string[]): string {
    return lines.length ? lines.join("\n") + "\n" : "";
}

/** Preserves the requested side order when composing one conflict's replacement lines. */
function choiceLines(
    choice: MergeChoice,
    segment: { oursLines: string[]; theirsLines: string[]; baseLines: string[] },
): string[] {
    switch (choice) {
        case "ours":
            return segment.oursLines;
        case "theirs":
            return segment.theirsLines;
        case "both":
            return [...segment.oursLines, ...segment.theirsLines];
        case "both-reversed":
            return [...segment.theirsLines, ...segment.oursLines];
        case "base":
            return segment.baseLines;
        case "none":
            return [];
    }
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
            edited: hunk.edited || !!changes.touchesRange(hunk.from, hunk.to),
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

/** Resolves all selected hunks in one history step using start-document coordinates. */
export function bulkResolve(
    state: EditorState,
    picks: ReadonlyMap<number, MergeChoice>,
    data: MergeEditorData,
): TransactionSpec {
    const changes: { from: number; to: number; insert: string }[] = [];
    const doc = state.doc;
    let delta = 0;
    const next = state.field(workbenchHunks).map((target, index) => {
        const from = target.from + delta;
        const choice = picks.get(index);
        if (choice === undefined) return { ...target, from, to: target.to + delta };
        let content = linesText(choiceLines(choice, target.segment));
        if (target.to === doc.length && !data.hasTrailingNewline && content.endsWith("\n"))
            content = content.slice(0, -1);
        changes.push({ from: target.from, to: target.to, insert: content });
        delta += content.length - (target.to - target.from);
        return {
            ...target,
            from,
            to: from + content.length,
            decision: choice,
            resolved: true,
            edited: false,
            dismissed: choice === "none" ? { ours: false, theirs: false } : target.dismissed,
        };
    });
    return {
        changes,
        effects: replaceHunks.of(next),
        userEvent: "input.merge",
        annotations: isolateHistory.of("full"),
    };
}

/** Dismisses one side without mutating the source hunks or changing their document ranges. */
export function dismissSide(
    hunks: readonly WorkbenchHunk[],
    index: number,
    side: "ours" | "theirs",
): WorkbenchHunk[] {
    return hunks.map((hunk, current) =>
        current === index ? { ...hunk, dismissed: { ...hunk.dismissed, [side]: true } } : hunk,
    );
}

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
