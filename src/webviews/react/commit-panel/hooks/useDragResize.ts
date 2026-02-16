// Handles vertical drag-to-resize logic for the bottom commit area.
// Returns the current height and a mousedown handler for the drag handle.

import { useState, useCallback, useRef } from "react";

interface DragResizeAPI {
    height: number;
    onMouseDown: (e: React.MouseEvent) => void;
}

export function useDragResize(
    initialHeight: number,
    minHeight: number,
    containerRef: React.RefObject<HTMLDivElement | null>,
): DragResizeAPI {
    const [height, setHeight] = useState(initialHeight);
    const dragging = useRef(false);

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragging.current = true;
            const startY = e.clientY;
            const startH = height;

            const onMouseMove = (ev: MouseEvent) => {
                if (!dragging.current) return;
                const delta = startY - ev.clientY;
                const maxH = containerRef.current ? containerRef.current.clientHeight - 60 : 500;
                setHeight(Math.max(minHeight, Math.min(maxH, startH + delta)));
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
        [height, minHeight, containerRef],
    );

    return { height, onMouseDown };
}
