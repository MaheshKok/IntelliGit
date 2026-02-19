// Handles vertical drag-to-resize logic for the bottom commit area.
// Returns the current height and a mousedown handler for the drag handle.

import { useState, useCallback, useRef } from "react";

interface DragResizeAPI {
    height: number;
    onMouseDown: (e: React.MouseEvent) => void;
}

interface DragResizeOptions {
    maxReservedHeight?: number;
    onResize?: (height: number) => void;
}

export function useDragResize(
    initialHeight: number,
    minHeight: number,
    containerRef: React.RefObject<HTMLDivElement | null>,
    options: DragResizeOptions = {},
): DragResizeAPI {
    const [height, setHeight] = useState(initialHeight);
    const dragging = useRef(false);
    const { maxReservedHeight = 60, onResize } = options;

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragging.current = true;
            const startY = e.clientY;
            const startH = height;

            const onMouseMove = (ev: MouseEvent) => {
                if (!dragging.current) return;
                const delta = startY - ev.clientY;
                const maxH = containerRef.current
                    ? containerRef.current.clientHeight - maxReservedHeight
                    : 500;
                const nextHeight = Math.max(minHeight, Math.min(maxH, startH + delta));
                setHeight(nextHeight);
                onResize?.(nextHeight);
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
        [containerRef, height, maxReservedHeight, minHeight, onResize],
    );

    return { height, onMouseDown };
}
