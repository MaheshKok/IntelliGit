import { useCallback, useMemo, useRef, useState } from "react";
import type React from "react";
import type { WorkingFile } from "../../../../types";

const UNVERSIONED_DRAG_MIME = "application/vnd.intelligit.unversioned-files";

interface UseFileDragOptions {
    unversioned: WorkingFile[];
    onFileClick: (path: string) => void;
    onTrackUnversionedFiles?: (paths: string[]) => void;
}

/** Owns unversioned-file drag selection and drop handlers for FileTree. */
export function useFileDrag({
    unversioned,
    onFileClick,
    onTrackUnversionedFiles,
}: UseFileDragOptions) {
    const [isDragOverChanges, setIsDragOverChanges] = useState(false);
    const [dragSelectedUnversionedPaths, setDragSelectedUnversionedPaths] = useState<Set<string>>(
        () => new Set(),
    );
    const dragCounterRef = useRef(0);
    const activeUnversionedDragPathsRef = useRef<string[]>([]);
    const unversionedPaths = useMemo(
        () => new Set(unversioned.map((file) => file.path)),
        [unversioned],
    );
    const visibleDragSelectedUnversionedPaths = useMemo(() => {
        const next = new Set(
            Array.from(dragSelectedUnversionedPaths).filter((path) => unversionedPaths.has(path)),
        );
        return next.size === dragSelectedUnversionedPaths.size
            ? dragSelectedUnversionedPaths
            : next;
    }, [dragSelectedUnversionedPaths, unversionedPaths]);

    const getUnversionedDragPaths = useCallback(
        (file: WorkingFile): string[] => {
            if (file.status !== "?") return [];
            const selectedUnversioned = Array.from(visibleDragSelectedUnversionedPaths);
            if (selectedUnversioned.length === 0) return [file.path];
            return selectedUnversioned.includes(file.path) ? selectedUnversioned : [file.path];
        },
        [visibleDragSelectedUnversionedPaths],
    );

    const handleTreeFileClick = useCallback(
        (event: React.MouseEvent<HTMLElement>, file: WorkingFile) => {
            if (file.status === "?" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.stopPropagation();
                setDragSelectedUnversionedPaths((prev) => {
                    const next = new Set(
                        Array.from(prev).filter((path) => unversionedPaths.has(path)),
                    );
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                });
                return;
            }
            setDragSelectedUnversionedPaths(new Set());
            onFileClick(file.path);
        },
        [onFileClick, unversionedPaths],
    );

    const handleFileDragStart = useCallback(
        (event: React.DragEvent<HTMLElement>, file: WorkingFile) => {
            const paths = getUnversionedDragPaths(file);
            if (paths.length === 0) {
                activeUnversionedDragPathsRef.current = [];
                event.preventDefault();
                return;
            }
            activeUnversionedDragPathsRef.current = paths;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(UNVERSIONED_DRAG_MIME, JSON.stringify(paths));
            event.dataTransfer.setData("text/plain", paths.join("\n"));

            // Show file count on the drag cursor.
            if (paths.length > 1 && typeof event.dataTransfer.setDragImage === "function") {
                const badge = document.createElement("div");
                badge.textContent = String(paths.length);
                badge.style.cssText =
                    "position:absolute;left:-9999px;background:var(--intelligit-pycharm-blue,#3b82f6);color:#fff;font-size:11px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 5px;line-height:1";
                document.body.appendChild(badge);
                event.dataTransfer.setDragImage(badge, 0, 0);
                requestAnimationFrame(() => badge.remove());
            }
        },
        [getUnversionedDragPaths],
    );

    const handleFileDragEnd = useCallback(() => {
        activeUnversionedDragPathsRef.current = [];
        dragCounterRef.current = 0;
        setIsDragOverChanges(false);
    }, []);

    const normalizeDraggedUnversionedPaths = useCallback(
        (paths: unknown[]): string[] =>
            paths.filter(
                (path): path is string => typeof path === "string" && unversionedPaths.has(path),
            ),
        [unversionedPaths],
    );

    const readDraggedUnversionedPaths = useCallback(
        (dataTransfer: DataTransfer): string[] => {
            const raw = dataTransfer.getData(UNVERSIONED_DRAG_MIME);
            if (!raw)
                return normalizeDraggedUnversionedPaths(activeUnversionedDragPathsRef.current);
            try {
                const parsed: unknown = JSON.parse(raw);
                if (!Array.isArray(parsed)) return [];
                return normalizeDraggedUnversionedPaths(parsed);
            } catch {
                return [];
            }
        },
        [normalizeDraggedUnversionedPaths],
    );

    const canAcceptUnversionedDrop = useCallback(
        (dataTransfer: DataTransfer): boolean => {
            if (
                normalizeDraggedUnversionedPaths(activeUnversionedDragPathsRef.current).length > 0
            ) {
                return true;
            }
            return Array.from(dataTransfer.types).includes(UNVERSIONED_DRAG_MIME);
        },
        [normalizeDraggedUnversionedPaths],
    );

    const handleChangesDragEnter = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            if (!canAcceptUnversionedDrop(event.dataTransfer)) return;
            event.preventDefault();
            dragCounterRef.current += 1;
            setIsDragOverChanges(true);
        },
        [canAcceptUnversionedDrop],
    );

    const handleChangesDragOver = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            if (!canAcceptUnversionedDrop(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
        },
        [canAcceptUnversionedDrop],
    );

    const handleChangesDragLeave = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            if (!canAcceptUnversionedDrop(event.dataTransfer)) return;
            dragCounterRef.current -= 1;
            if (dragCounterRef.current <= 0) {
                dragCounterRef.current = 0;
                setIsDragOverChanges(false);
            }
        },
        [canAcceptUnversionedDrop],
    );

    const handleChangesDrop = useCallback(
        (event: React.DragEvent<HTMLDivElement>) => {
            const paths = readDraggedUnversionedPaths(event.dataTransfer);
            dragCounterRef.current = 0;
            setIsDragOverChanges(false);
            activeUnversionedDragPathsRef.current = [];
            if (paths.length === 0) return;
            event.preventDefault();
            onTrackUnversionedFiles?.(paths);
        },
        [onTrackUnversionedFiles, readDraggedUnversionedPaths],
    );

    return {
        visibleDragSelectedUnversionedPaths,
        isDragOverChanges,
        handleTreeFileClick,
        handleFileDragStart,
        handleFileDragEnd,
        handleChangesDragEnter,
        handleChangesDragOver,
        handleChangesDragLeave,
        handleChangesDrop,
    };
}
