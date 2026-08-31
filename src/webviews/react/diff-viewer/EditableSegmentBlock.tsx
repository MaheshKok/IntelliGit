import React from "react";
import type { DiffSegment } from "../../protocol/diffViewerTypes";
import { t } from "../shared/i18n";
import { CodeBlock, intrinsicSizeStyle, type LineNumberSpec } from "../diff-core/segments";
import { segmentClassName, type DiffPane } from "./segmentMarkers";

/** The segment data and derived geometry shared by both pane renderers. */
export interface EditableSegmentItem {
    segment: DiffSegment;
    index: number;
    /** Cached word-diff counterparts when the item comes from the rendered-segment model. */
    alignedCompareLines?: { readonly left: string[]; readonly right: string[] };
    paneLines: Record<DiffPane, number>;
    lineNumbers: Record<DiffPane, LineNumberSpec>;
    canonicalLineCount: number;
}

/** Computes the source-text offset represented by a click in one syntax-highlighted segment. */
function caretOffsetWithinBlock(
    block: HTMLElement,
    sourceLines: readonly string[],
    clientX: number,
    clientY: number,
): number {
    try {
        const position = document.caretPositionFromPoint?.(clientX, clientY);
        const range = position ? undefined : document.caretRangeFromPoint?.(clientX, clientY);
        const node = position?.offsetNode ?? range?.startContainer;
        const offset = position?.offset ?? range?.startOffset;
        if (node?.nodeType !== Node.TEXT_NODE || offset === undefined) return 0;

        const row = node.parentElement?.closest<HTMLElement>(".code-line");
        const codeLines = row?.parentElement;
        if (
            !row?.classList.contains("real-code-line") ||
            !codeLines?.classList.contains("code-lines") ||
            !block.contains(row)
        ) {
            return 0;
        }

        const rows = [...codeLines.querySelectorAll<HTMLElement>(":scope > .code-line")];
        const rowIndex = rows.indexOf(row);
        if (rowIndex < 0) return 0;

        const rowRange = document.createRange();
        rowRange.selectNodeContents(row);
        rowRange.setEnd(node, offset);
        return (
            sourceLines
                .slice(0, rowIndex)
                .reduce((total, previous) => total + previous.length + 1, 0) +
            rowRange.toString().length
        );
    } catch {
        return 0;
    }
}

/** Props for an inactive editable segment shell. */
export interface EditableSegmentBlockProps {
    item: EditableSegmentItem;
    side: DiffPane;
    lineNumberSide: "left" | "right";
    highlightWords: boolean;
    onStartEditing: (item: EditableSegmentItem, caretOffset?: number) => void;
}

/**
 * What opens the editor from the keyboard.
 *
 * Enter and Space are the WAI-ARIA button pattern, which `role="button"` below is a promise to
 * honour; F2 is the rename/edit key VS Code already trains its users on. A set rather than a
 * chain of `!==` so adding the next one costs a word instead of a branch.
 */
const EDITOR_OPEN_KEYS = new Set(["Enter", " ", "F2"]);

/** Renders one inactive editable block. */
export const EditableSegmentBlock = React.memo(function EditableSegmentBlock({
    item,
    side,
    lineNumberSide,
    highlightWords,
    onStartEditing,
}: EditableSegmentBlockProps): React.ReactElement {
    const lines = item.segment[side];
    const compareLines =
        item.alignedCompareLines?.[side] ?? item.segment[side === "left" ? "right" : "left"];
    const lineCount = item.paneLines[side];

    return (
        <div
            className={`segment diff-editable-block ${segmentClassName(item.segment, side)}`}
            style={intrinsicSizeStyle(lineCount)}
            onClick={(event) => {
                if (window.getSelection()?.isCollapsed === false) return;
                onStartEditing(
                    item,
                    caretOffsetWithinBlock(
                        event.currentTarget,
                        lines,
                        event.clientX,
                        event.clientY,
                    ),
                );
            }}
            onDoubleClick={() => onStartEditing(item)}
            onKeyDown={(event) => {
                if (!EDITOR_OPEN_KEYS.has(event.key)) return;
                // Space in particular: its default action scrolls, so a keyboard user who did
                // not get `preventDefault` here would see the pane jump instead of the editor
                // open -- a key that does something, just not the thing it was pressed for.
                event.preventDefault();
                onStartEditing(item);
            }}
            // A native <button> is invalid here twice over: its content model is phrasing
            // content, and CodeBlock renders line <div>s; and a real button suppresses text
            // selection, which the onClick above deliberately honours (it bails when the
            // selection is non-collapsed) so a reader can copy code without opening the editor.
            // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
            role="button"
            tabIndex={0}
            title={t("diff.editable.blockHint")}
            aria-label={t("diff.editable.blockHint")}
        >
            <CodeBlock
                lines={lines}
                lineCount={lineCount}
                lineNumbers={item.lineNumbers[side]}
                lineNumberSide={lineNumberSide}
                wordHighlight={highlightWords}
                compareLines={compareLines}
            />
        </div>
    );
});
