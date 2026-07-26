// Handles vertical drag-to-resize logic for the bottom commit area.
// Returns the current height and a mousedown handler for the drag handle.

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";

interface DragResizeAPI {
    height: number;
    onMouseDown: (e: React.MouseEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
}

/** Options that constrain and observe commit-panel drag resizing. */
export interface DragResizeOptions {
    maxReservedHeight?: number;
    onResize?: (height: number) => void;
}

const FALLBACK_MAX_HEIGHT = 500;

function getMaxHeight(
    containerRef: React.RefObject<HTMLDivElement | null>,
    maxReservedHeight: number,
): number {
    return containerRef.current
        ? containerRef.current.clientHeight - maxReservedHeight
        : FALLBACK_MAX_HEIGHT;
}

function clampHeight(height: number, minHeight: number, maxHeight: number): number {
    return Math.max(minHeight, Math.min(maxHeight, height));
}

/**
 * Provides vertical drag-to-resize state for the commit-panel bottom area.
 *
 * The hook installs document-level mouse listeners only for the active drag,
 * clamps the height against the container minus reserved space, and reports each
 * accepted height through `onResize` without owning the resized content.
 */
export function useDragResize(
    initialHeight: number,
    minHeight: number,
    containerRef: React.RefObject<HTMLDivElement | null>,
    options: DragResizeOptions = {},
): DragResizeAPI {
    const { maxReservedHeight = 60, onResize } = options;
    const [height, setHeight] = useState(() =>
        clampHeight(initialHeight, minHeight, getMaxHeight(containerRef, maxReservedHeight)),
    );
    const visibleHeight = clampHeight(
        height,
        minHeight,
        getMaxHeight(containerRef, maxReservedHeight),
    );
    const dragging = useRef(false);
    const heightRef = useRef(visibleHeight);
    const onResizeRef = useRef(onResize);

    useEffect(() => {
        onResizeRef.current = onResize;
    }, [onResize]);

    useEffect(() => {
        heightRef.current = visibleHeight;
    }, [visibleHeight]);

    useLayoutEffect(() => {
        const nextHeight = clampHeight(
            heightRef.current,
            minHeight,
            getMaxHeight(containerRef, maxReservedHeight),
        );
        if (nextHeight !== heightRef.current) {
            setHeight(nextHeight);
        }
    }, [containerRef, maxReservedHeight, minHeight]);

    const updateHeight = useCallback(
        (requestedHeight: number): void => {
            const nextHeight = clampHeight(
                requestedHeight,
                minHeight,
                getMaxHeight(containerRef, maxReservedHeight),
            );
            heightRef.current = nextHeight;
            setHeight(nextHeight);
            onResizeRef.current?.(nextHeight);
        },
        [containerRef, maxReservedHeight, minHeight],
    );

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragging.current = true;
            const startY = e.clientY;
            const startH = heightRef.current;

            const onMouseMove = (ev: MouseEvent) => {
                if (!dragging.current) return;
                const delta = startY - ev.clientY;
                updateHeight(startH + delta);
            };

            const onMouseUp = () => {
                dragging.current = false;
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
        },
        [updateHeight],
    );

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent): void => {
            const delta = event.key === "ArrowUp" ? 10 : event.key === "ArrowDown" ? -10 : 0;
            if (delta === 0) return;
            event.preventDefault();
            updateHeight(heightRef.current + delta);
        },
        [updateHeight],
    );

    return { height: visibleHeight, onMouseDown, onKeyDown };
}
