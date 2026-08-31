// What a reader can do with the keyboard: be refused, politely and in the right place, when
// typing into the pane that is not editable, and walk between changes with Alt+Arrow.
//
// Split out of `App`. The two share nothing but their trigger, and are here together because
// "the keyboard" is the one surface a reader notices them on.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffViewerData } from "../../protocol/diffViewerTypes";
import { DIFF_PANES, type DiffPane } from "./segmentMarkers";
import { paneEditor } from "./diffViewerModel";

const READ_ONLY_NOTICE_MS = 2500;

/**
 * Where the refusal is spoken when the caret cannot be measured -- a keyboard-only attempt
 * with no selection, or a collapsed range the browser reports as an empty rect at the origin.
 * Just inside the top-left of the panes, so the notice is still visibly ABOUT the diff rather
 * than pinned to a corner of the window.
 */
const READ_ONLY_NOTICE_FALLBACK_POINT = { x: 12, y: 12 } as const;

export function isReadOnlyPane(editablePane: DiffPane | undefined, pane: DiffPane): boolean {
    return editablePane !== pane;
}

/** Where the caret sits, so the notice can be spoken next to it rather than in the header. */
export interface CaretPoint {
    readonly x: number;
    readonly y: number;
}

function caretPointWithin(host: HTMLElement): CaretPoint | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    // A collapsed range at the very start of a line can measure zero on both axes, which
    // would pin the notice to the viewer's top-left corner rather than to the caret.
    if (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0) return null;
    return { x: rect.left - hostRect.left, y: rect.top - hostRect.top };
}

function clearReadOnlyNoticeTimer(
    timerRef: React.MutableRefObject<ReturnType<typeof window.setTimeout> | null>,
): void {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
}

/**
 * Puts a caret in the read-only pane and refuses every edit made with it.
 *
 * `rootRef` is the box the notice is positioned against, and `columnRefs` are the panes the
 * refusal is attached to -- both belong to the render, so they are passed in rather than created
 * here: an element this hook made would not be the element the reader clicked.
 */
export function useReadOnlyNotice(
    data: DiffViewerData | null,
    rootRef: React.MutableRefObject<HTMLDivElement | null>,
    columnRefs: React.MutableRefObject<Record<DiffPane, HTMLDivElement | null>>,
): CaretPoint | null {
    const [readOnlyNotice, setReadOnlyNotice] = useState<CaretPoint | null>(null);
    const readOnlyNoticeTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
    const handleReadOnlyAttempt = useCallback((at: CaretPoint | null) => {
        clearReadOnlyNoticeTimer(readOnlyNoticeTimerRef);
        setReadOnlyNotice(at ?? READ_ONLY_NOTICE_FALLBACK_POINT);
        readOnlyNoticeTimerRef.current = window.setTimeout(() => {
            readOnlyNoticeTimerRef.current = null;
            setReadOnlyNotice(null);
        }, READ_ONLY_NOTICE_MS);
    }, []);

    useEffect(() => {
        return () => clearReadOnlyNoticeTimer(readOnlyNoticeTimerRef);
    }, []);

    /**
     * A caret in the read-only pane, and a refusal when the reader tries to type into it.
     *
     * `contentEditable` is what puts a real caret on a plain div -- clicking places it, the
     * arrow keys move it, and a selection spans lines the way it does in the editable pane.
     * Every actual edit is then refused at `beforeinput`, which the browser raises for
     * typing, paste, cut, delete and drop alike. Enumerating those as keystrokes instead
     * would cover the ones remembered on the day it was written; this covers whatever the
     * browser itself counts as changing the text.
     */
    useEffect(() => {
        if (!data) return;
        const host = rootRef.current;
        const disposers: Array<() => void> = [];
        for (const pane of DIFF_PANES) {
            if (paneEditor(data, pane)) continue;
            const element = columnRefs.current[pane];
            if (!element) continue;
            // Refuse on every pane that carries the caret, but only ACCUSE on the ones the
            // lock icon also calls read-only. A payload that names an editable side and
            // omits the document behind it renders immutable blocks on that side too: it
            // must still swallow the keystroke -- there is nowhere to save it -- while
            // staying silent, or the notice would contradict its own pane's missing lock.
            const refuse = (event: Event): void => {
                event.preventDefault();
                if (!isReadOnlyPane(data.editablePane, pane)) return;
                handleReadOnlyAttempt(host ? caretPointWithin(host) : null);
            };
            element.addEventListener("beforeinput", refuse);
            disposers.push(() => element.removeEventListener("beforeinput", refuse));
        }
        return () => disposers.forEach((dispose) => dispose());
    }, [columnRefs, data, handleReadOnlyAttempt, rootRef]);

    return readOnlyNotice;
}

/** Alt+Arrow walks between changes, wherever the focus is outside a text field. */
export function useDiffKeyboardNav(jumpToAdjacentChange: (direction: 1 | -1) => boolean): void {
    // The stripe marks are aria-hidden and take no tab stops -- one per change would be
    // hundreds on a real diff -- so click-to-jump is a pointer affordance only. Without a
    // key for the same move, reaching the next change from the keyboard means scrolling
    // and looking for it, which is the gap this closes.
    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            // A composing IME owns the arrow keys for its candidate list, and inside a text
            // field this chord is already taken -- macOS walks the caret by paragraph on
            // Option+Up/Down, which an open edit block needs. The diff claims it outside a
            // field only, so nothing a reader can type into loses a key it already had.
            if (event.isComposing) return;
            const target = event.target;
            if (
                target instanceof HTMLElement &&
                (target.isContentEditable || target.closest("input, textarea") !== null)
            ) {
                return;
            }
            if (jumpToAdjacentChange(event.key === "ArrowDown" ? 1 : -1)) event.preventDefault();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [jumpToAdjacentChange]);
}
