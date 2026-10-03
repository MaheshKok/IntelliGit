import { useEffect, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import type { WorkbenchHunk } from "./workbenchModel";

/** Selects the original input or live result boundary used by linked-scroll interpolation. */
function anchor(hunk: WorkbenchHunk, pane: number, end: boolean): number {
    if (pane === 0) return end ? hunk.oursTo : hunk.oursFrom;
    if (pane === 2) return end ? hunk.theirsTo : hunk.theirsFrom;
    return end ? hunk.to : hunk.from;
}

/** Maps scrolling through stable hunk boundaries rather than unequal pane height ratios. */
export function mappedMergePosition(
    position: number,
    fromPane: number,
    toPane: number,
    hunks: readonly WorkbenchHunk[],
    lengths: readonly number[],
): number {
    let sourceStart = 0;
    let targetStart = 0;
    for (const hunk of hunks) {
        for (const end of [false, true]) {
            const sourceEnd = Math.min(anchor(hunk, fromPane, end), lengths[fromPane]);
            const targetEnd = Math.min(anchor(hunk, toPane, end), lengths[toPane]);
            if (position <= sourceEnd)
                return (
                    targetStart +
                    ((targetEnd - targetStart) * (position - sourceStart)) /
                        Math.max(1, sourceEnd - sourceStart)
                );
            sourceStart = sourceEnd;
            targetStart = targetEnd;
        }
    }
    return (
        targetStart +
        ((lengths[toPane] - targetStart) * (position - sourceStart)) /
            Math.max(1, lengths[fromPane] - sourceStart)
    );
}

/** Links input and result scrolling without dispatching history-changing transactions. */
export function useMergeScrollSync(
    editors: RefObject<Array<{ view: EditorView }>>,
    hunks: readonly WorkbenchHunk[],
    enabled: boolean,
): void {
    // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- Cleanup removes each captured scroll listener and cancels both the sync and release animation frames.
    useEffect(() => {
        const views = editors.current?.slice(0, 3).map((editor) => editor.view) ?? [];
        if (!enabled || views.length !== 3) return;
        let frame = 0;
        let releaseFrame = 0;
        let syncing = false;
        const listeners = views.map((source, sourcePane) => {
            const scroll = () => {
                if (syncing || frame) return;
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    syncing = true;
                    const sourceTop = source.scrollDOM.scrollTop;
                    const sourceBlock = source.lineBlockAtHeight(sourceTop);
                    const offset = sourceTop - sourceBlock.top;
                    const lengths = views.map((view) => view.state.doc.length);
                    views.forEach((target, targetPane) => {
                        if (targetPane === sourcePane) return;
                        const position = Math.round(
                            mappedMergePosition(
                                sourceBlock.from,
                                sourcePane,
                                targetPane,
                                hunks,
                                lengths,
                            ),
                        );
                        const targetBlock = target.lineBlockAt(
                            Math.max(0, Math.min(position, target.state.doc.length)),
                        );
                        target.scrollDOM.scrollTop = targetBlock.top + offset;
                        target.scrollDOM.scrollLeft = source.scrollDOM.scrollLeft;
                    });
                    releaseFrame = requestAnimationFrame(() => {
                        releaseFrame = 0;
                        syncing = false;
                    });
                });
            };
            return { source, scroll };
        });
        for (const { source, scroll } of listeners)
            source.scrollDOM.addEventListener("scroll", scroll);
        return () => {
            cancelAnimationFrame(releaseFrame);
            cancelAnimationFrame(frame);
            for (const { source, scroll } of listeners)
                source.scrollDOM.removeEventListener("scroll", scroll);
        };
    }, [editors, enabled, hunks]);
}
