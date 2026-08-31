// The webview's half of the conversation with the extension host: the payload it receives, and
// the single `editText` message every change goes out as.
//
// Split out of `App`. Reverting a hunk is here too, and deliberately goes down the same outbound
// path a typed edit does -- see `useRevertHunk` for why that is the point rather than a shortcut.

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
    DiffViewerData,
    InboundMessage,
    OutboundMessage,
} from "../../protocol/diffViewerTypes";
import { getVsCodeApi } from "../shared/vscodeApi";
import { paneStartLine, replaceBlockLines } from "./editableDraftSession";
import type { RenderedSegment } from "./renderedDiffSegments";
import { reconcileDiffViewerData } from "./reconcileDiffSegments";

/** Everything the render learns from the host, and the one way it answers back. */
export interface DiffViewerHost {
    readonly data: DiffViewerData | null;
    readonly error: string | null;
    readonly ignoreMode: "none" | "whitespace";
    readonly handleIgnoreMode: () => void;
    readonly handleEdit: (
        currentText: string,
        nextText: string,
        baseVersion: number,
        baseReseedToken: number,
    ) => void;
}

/** Subscribes to the host's payloads and announces the webview is ready to receive them. */
export function useDiffViewerHost(): DiffViewerHost {
    const [data, setData] = useState<DiffViewerData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [ignoreMode, setIgnoreMode] = useState<"none" | "whitespace">("none");

    const vscode = useMemo(() => getVsCodeApi<OutboundMessage, unknown>(), []);

    const handleIgnoreMode = useCallback(() => {
        const mode = ignoreMode === "none" ? "whitespace" : "none";
        setIgnoreMode(mode);
        vscode.postMessage({ type: "setIgnoreMode", mode });
    }, [ignoreMode, vscode]);

    const handleEdit = useCallback(
        (currentText: string, nextText: string, baseVersion: number, baseReseedToken: number) => {
            if (!data?.editablePane) return;
            let startOffset = 0;
            while (
                startOffset < currentText.length &&
                startOffset < nextText.length &&
                currentText[startOffset] === nextText[startOffset]
            ) {
                startOffset++;
            }
            let currentEnd = currentText.length;
            let nextEnd = nextText.length;
            while (
                currentEnd > startOffset &&
                nextEnd > startOffset &&
                currentText[currentEnd - 1] === nextText[nextEnd - 1]
            ) {
                currentEnd--;
                nextEnd--;
            }
            // Both scans compare UTF-16 code units, so either can stop between the halves of
            // a surrogate pair -- two emoji in the same 1024-point block share a high
            // surrogate. That emits a lone surrogate over a range bisecting a character.
            // Step each boundary back onto a code-point edge.
            const lead = currentText.charCodeAt(startOffset - 1);
            if (startOffset > 0 && lead >= 0xd800 && lead <= 0xdbff) startOffset--;
            const tail = currentText.charCodeAt(currentEnd);
            if (tail >= 0xdc00 && tail <= 0xdfff) {
                currentEnd++;
                nextEnd++;
            }
            vscode.postMessage({
                type: "editText",
                delta: {
                    baseVersion,
                    baseReseedToken,
                    startOffset,
                    endOffset: currentEnd,
                    text: nextText.slice(startOffset, nextEnd),
                },
            });
        },
        [data?.editablePane, vscode],
    );

    // The three writes below land in one render: React 18 auto-batches updates from any
    // callback, `message` listeners included, so this is one redraw and not three. They are
    // also unrelated to each other -- an error banner, a whitespace mode and the payload --
    // so a reducer would join three independent things to satisfy a count.
    // react-doctor-disable-next-line react-doctor/no-cascading-set-state
    useEffect(() => {
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setDiffData") {
                setError(event.data.data.loadError ?? null);
                setIgnoreMode(event.data.data.ignoreWhitespace ? "whitespace" : "none");
                setData((previous) => reconcileDiffViewerData(previous, event.data.data));
            }
        };
        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, [vscode]);

    return { data, error, ignoreMode, handleIgnoreMode, handleEdit };
}

/**
 * Reverting one hunk, as a document edit.
 *
 * Separate from `useDiffViewerHost` because it needs the rendered segments, which are derived
 * from the very payload that hook delivers. Folding it in would mean the model had to run before
 * the hook that produces its input.
 */
export function useRevertHunk(
    data: DiffViewerData | null,
    renderedSegments: readonly RenderedSegment[],
    handleEdit: DiffViewerHost["handleEdit"],
): (index: number) => void {
    // Reverting is a document edit, deliberately: it goes down the same offset-diff and
    // `editText` path a typed block commit does, so it lands in VS Code's undo stack, is
    // stamped with the version and reseed token the draft machinery already uses to reject
    // a stale write, and needs no second host command to review.
    const handleRevertHunk = useCallback(
        (index: number) => {
            const pane = data?.editablePane;
            const sourceText = data?.editableText;
            const version = data?.documentVersion;
            if (pane === undefined || sourceText === undefined || version === undefined) return;
            const item = renderedSegments[index];
            if (item === undefined) return;
            const nextText = replaceBlockLines(
                sourceText,
                paneStartLine(renderedSegments, index, pane),
                item.segment[pane].length,
                item.segment[pane === "left" ? "right" : "left"],
            );
            if (nextText === sourceText) return;
            handleEdit(sourceText, nextText, version, data?.editableReseedToken ?? 0);
        },
        [data, handleEdit, renderedSegments],
    );
    return handleRevertHunk;
}
