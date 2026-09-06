// Drag-to-resize model for the commit list's Author and Date columns (issue #155).
// The handle sits on the left edge of each right-aligned column, so dragging it
// left widens the column. Widths persist in localStorage, which VS Code keys on
// the webview's view type, so the sidebar graph and the undocked window each
// keep their own layout.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../shared/i18n";
import {
    CHECKS_COL_WIDTH,
    DEFAULT_META_COLUMN_WIDTHS,
    MESSAGE_MIN_WIDTH,
    METADATA_COLUMN_MARGIN,
    type MetaColumnKey,
    type MetaColumnWidths,
    visibleMetaColumns,
} from "./styles";

export const META_COLUMN_WIDTHS_STORAGE_KEY = "intelligit.commitList.metaColumnWidths";
export const MIN_META_COL_WIDTH = 40;
/** Pixels one arrow-key press moves a divider. */
const KEYBOARD_RESIZE_STEP = 8;
/** Ceiling for a stored width; the live ceiling is the pane budget in `resizeMetaColumn`. */
const MAX_STORED_META_COL_WIDTH = 600;

function clampWidth(width: number, max: number): number {
    return Math.max(MIN_META_COL_WIDTH, Math.min(max, Math.round(width)));
}

/** Width one metadata column may take beside the minimum message cell and the checks column. */
function firstColumnBudget(availableWidth: number, showChecks: boolean): number {
    const checks = showChecks ? CHECKS_COL_WIDTH + METADATA_COLUMN_MARGIN : 0;
    return availableWidth - MESSAGE_MIN_WIDTH - METADATA_COLUMN_MARGIN - checks;
}

/**
 * Applies a pointer delta to one column. Growth stops where `visibleMetaColumns`
 * would hide a column, because a hidden column takes its handle with it and the
 * user could never drag it back. Only a column that is actually visible reserves
 * space, and a cap below the current width never shrinks the column by itself,
 * so the first pixel of a drag on a narrow pane is never a snap.
 */
export function resizeMetaColumn(
    widths: MetaColumnWidths,
    key: MetaColumnKey,
    delta: number,
    availableWidth: number,
    showChecks: boolean,
): MetaColumnWidths {
    const other: MetaColumnKey = key === "author" ? "date" : "author";
    const reserved = visibleMetaColumns(availableWidth, showChecks, widths)[other]
        ? widths[other] + METADATA_COLUMN_MARGIN
        : 0;
    const max = Math.max(widths[key], firstColumnBudget(availableWidth, showChecks) - reserved);
    return { ...widths, [key]: clampWidth(widths[key] - delta, max) };
}

/**
 * Shrinks stored widths to the pane so a width saved on a wide pane cannot hide a
 * column, and its only reset affordance, on a narrow one. Never shrinks below the
 * defaults, so an untouched layout renders exactly as it did before resizing existed.
 */
export function fitMetaColumnWidths(
    widths: MetaColumnWidths,
    availableWidth: number,
    showChecks: boolean,
): MetaColumnWidths {
    const authorMax = firstColumnBudget(availableWidth, showChecks);
    const author = Math.min(widths.author, Math.max(DEFAULT_META_COLUMN_WIDTHS.author, authorMax));
    const dateMax = authorMax - author - METADATA_COLUMN_MARGIN;
    const date = Math.min(widths.date, Math.max(DEFAULT_META_COLUMN_WIDTHS.date, dateMax));
    return author === widths.author && date === widths.date ? widths : { author, date };
}

/** Restores persisted widths, falling back to defaults for anything malformed. */
export function readStoredMetaColumnWidths(): MetaColumnWidths {
    try {
        const raw = localStorage.getItem(META_COLUMN_WIDTHS_STORAGE_KEY);
        if (!raw) return DEFAULT_META_COLUMN_WIDTHS;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return DEFAULT_META_COLUMN_WIDTHS;
        const { author, date } = parsed as Record<string, unknown>;
        if (!Number.isFinite(author) || !Number.isFinite(date)) return DEFAULT_META_COLUMN_WIDTHS;
        return {
            author: clampWidth(author as number, MAX_STORED_META_COL_WIDTH),
            date: clampWidth(date as number, MAX_STORED_META_COL_WIDTH),
        };
    } catch {
        return DEFAULT_META_COLUMN_WIDTHS;
    }
}

function persistMetaColumnWidths(widths: MetaColumnWidths): void {
    try {
        localStorage.setItem(META_COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
    } catch {
        // Storage unavailable: the widths still apply for this session.
    }
}

interface MetaColumnResizeApi {
    widths: MetaColumnWidths;
    /** The column under an active pointer drag, so the list can paint a guide for it. */
    resizing: MetaColumnKey | null;
    startResize: (key: MetaColumnKey, event: React.MouseEvent) => void;
    /** Moves one divider by `delta` pixels (negative widens) and persists the result. */
    nudgeColumn: (key: MetaColumnKey, delta: number) => void;
    resetColumn: (key: MetaColumnKey) => void;
}

/**
 * Owns the metadata column widths for one commit list: restores them on mount,
 * fits them to the current pane, drives a document-level drag, and persists on
 * release, keyboard step, or reset.
 */
export function useMetaColumnWidths(
    availableWidth: number,
    showChecks: boolean,
): MetaColumnResizeApi {
    const [stored, setStored] = useState(readStoredMetaColumnWidths);
    const [resizing, setResizing] = useState<MetaColumnKey | null>(null);
    const widths = useMemo(
        () => fitMetaColumnWidths(stored, availableWidth, showChecks),
        [stored, availableWidth, showChecks],
    );
    const widthsRef = useRef(widths);
    const layoutRef = useRef({ availableWidth, showChecks });
    useEffect(() => {
        widthsRef.current = widths;
        layoutRef.current = { availableWidth, showChecks };
    });
    const cleanupRef = useRef<(() => void) | null>(null);
    useEffect(() => () => cleanupRef.current?.(), []);

    const commit = useCallback((next: MetaColumnWidths) => {
        setStored(next);
        persistMetaColumnWidths(next);
    }, []);

    const startResize = useCallback((key: MetaColumnKey, event: React.MouseEvent) => {
        event.preventDefault();
        cleanupRef.current?.();
        const startX = event.clientX;
        const startWidths = widthsRef.current;
        let latest = startWidths;
        const previousCursor = document.body.style.cursor;
        const previousUserSelect = document.body.style.userSelect;

        const onMouseMove = (ev: MouseEvent) => {
            const layout = layoutRef.current;
            latest = resizeMetaColumn(
                startWidths,
                key,
                ev.clientX - startX,
                layout.availableWidth,
                layout.showChecks,
            );
            setStored(latest);
        };
        const onMouseUp = () => {
            cleanupRef.current?.();
            // A plain click, and each click of a double-click, moves nothing: no write.
            if (latest !== startWidths) persistMetaColumnWidths(latest);
        };
        cleanupRef.current = () => {
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
            document.body.style.cursor = previousCursor;
            document.body.style.userSelect = previousUserSelect;
            cleanupRef.current = null;
            setResizing(null);
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        setResizing(key);
    }, []);

    const nudgeColumn = useCallback(
        (key: MetaColumnKey, delta: number) => {
            const layout = layoutRef.current;
            commit(
                resizeMetaColumn(
                    widthsRef.current,
                    key,
                    delta,
                    layout.availableWidth,
                    layout.showChecks,
                ),
            );
        },
        [commit],
    );

    const resetColumn = useCallback(
        (key: MetaColumnKey) => {
            commit({ ...widthsRef.current, [key]: DEFAULT_META_COLUMN_WIDTHS[key] });
        },
        [commit],
    );

    return { widths, resizing, startResize, nudgeColumn, resetColumn };
}

/**
 * Distance from the list's right edge to the left edge of `key`, where its
 * divider sits. Pure arithmetic over the same widths the header lays out with,
 * so a guide drawn here tracks the divider through a drag without measuring.
 */
export function metaColumnEdgeOffset(
    key: MetaColumnKey,
    widths: MetaColumnWidths,
    showDate: boolean,
    showChecks: boolean,
    sidePadding: number,
): number {
    const checks = showChecks ? CHECKS_COL_WIDTH + METADATA_COLUMN_MARGIN : 0;
    const date = key === "author" && showDate ? widths.date + METADATA_COLUMN_MARGIN : 0;
    return sidePadding + checks + date + widths[key];
}

const HANDLE_STYLE: React.CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -METADATA_COLUMN_MARGIN,
    width: METADATA_COLUMN_MARGIN + 3,
    cursor: "col-resize",
};

interface ColumnResizeHandleProps {
    column: MetaColumnKey;
    label: string;
    /** True while this divider is being dragged; the stylesheet keys its lit state on it. */
    active: boolean;
    onResizeStart: (key: MetaColumnKey, event: React.MouseEvent) => void;
    onNudge: (key: MetaColumnKey, delta: number) => void;
    onReset: (key: MetaColumnKey) => void;
}

/**
 * Header divider that resizes the column to its right: drag it, or focus it and
 * use the arrow keys. Double-click restores the default. A button, like the
 * undocked layout's dividers, so it is focusable without extra ARIA plumbing.
 * At rest it shows a small grip so the affordance is discoverable; hover, focus,
 * and drag light it up (see `COMMIT_ROW_CLASS_CSS`).
 */
export function ColumnResizeHandle({
    column,
    label,
    active,
    onResizeStart,
    onNudge,
    onReset,
}: ColumnResizeHandleProps): React.ReactElement {
    return (
        <button
            type="button"
            className="commit-column-resize"
            data-testid={`commit-column-resize-${column}`}
            data-resizing={active ? "true" : undefined}
            aria-label={t("a11y.resizeColumn", { column: label })}
            style={HANDLE_STYLE}
            onMouseDown={(event) => onResizeStart(column, event)}
            onDoubleClick={() => onReset(column)}
            onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                onNudge(
                    column,
                    event.key === "ArrowLeft" ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP,
                );
            }}
        />
    );
}
