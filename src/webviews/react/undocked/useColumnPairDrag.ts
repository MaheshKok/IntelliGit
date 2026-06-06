import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { MIN_SECTION_WIDTH, type SectionWidthKey, type SectionWidths } from "./sectionWidths";

export function useColumnPairDrag(
    widths: SectionWidths,
    setWidths: (widths: SectionWidths) => void,
    firstKey: SectionWidthKey,
    secondKey: SectionWidthKey,
): (e: ReactMouseEvent) => void {
    const draggingRef = useRef(false);
    const moveRef = useRef<((ev: MouseEvent) => void) | null>(null);
    const upRef = useRef<(() => void) | null>(null);
    const widthsRef = useRef(widths);
    widthsRef.current = widths;

    useEffect(() => {
        return () => {
            if (draggingRef.current) {
                if (moveRef.current) document.removeEventListener("mousemove", moveRef.current);
                if (upRef.current) document.removeEventListener("mouseup", upRef.current);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                draggingRef.current = false;
            }
        };
    }, []);

    return useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            draggingRef.current = true;
            const startX = e.clientX;
            const startWidths = widthsRef.current;
            const firstStart = startWidths[firstKey];
            const secondStart = startWidths[secondKey];
            const pairTotal = firstStart + secondStart;
            const pairMin = Math.min(MIN_SECTION_WIDTH, pairTotal / 2);

            const onMouseMove = (ev: MouseEvent) => {
                if (!draggingRef.current) return;
                const delta = ev.clientX - startX;
                const nextFirst = Math.max(
                    pairMin,
                    Math.min(pairTotal - pairMin, firstStart + delta),
                );
                setWidths({
                    ...startWidths,
                    [firstKey]: nextFirst,
                    [secondKey]: pairTotal - nextFirst,
                });
            };

            const onMouseUp = () => {
                draggingRef.current = false;
                moveRef.current = null;
                upRef.current = null;
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            moveRef.current = onMouseMove;
            upRef.current = onMouseUp;
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        },
        [firstKey, secondKey, setWidths],
    );
}
