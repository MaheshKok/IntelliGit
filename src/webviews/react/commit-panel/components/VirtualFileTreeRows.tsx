import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WorkingFile } from "../../../../types";
import type { TreeEntry, TreeFolder } from "../../shared/fileTree";
import {
    FileTreeRows,
    TreeFileRow,
    TreeFolderRow,
    type FileTreeRowsProps,
} from "../../shared/components/FileTreeRows";
import { JETBRAINS_UI } from "../../shared/tokens";

const ROW_HEIGHT = JETBRAINS_UI.size.treeRowHeight;
const OVERSCAN = 10;
export const VIRTUAL_THRESHOLD = 200;

interface VisibleRow {
    entry: TreeEntry<WorkingFile>;
    depth: number;
}

/** Flattens only expanded rows while retaining the existing tree order and indentation. */
export function visibleCommitRows(
    entries: readonly TreeEntry<WorkingFile>[],
    expanded: (path: string) => boolean,
    depth = 0,
): VisibleRow[] {
    const rows: VisibleRow[] = [];
    const append = (children: readonly TreeEntry<WorkingFile>[], level: number): void => {
        for (const entry of children) {
            rows.push({ entry, depth: level });
            if (entry.type === "folder" && expanded(entry.path)) append(entry.children, level + 1);
        }
    };
    append(entries, depth);
    return rows;
}

/** Uses the commit area's existing scroller instead of nesting another scrolling surface. */
function scrollParent(element: HTMLElement): HTMLElement {
    let parent = element.parentElement;
    while (parent) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
        parent = parent.parentElement;
    }
    return element.parentElement ?? element;
}

function fileCount(folder: TreeFolder<WorkingFile>): number {
    const descendants = (folder as TreeFolder<WorkingFile> & { descendantFiles?: WorkingFile[] })
        .descendantFiles;
    if (descendants) return descendants.length;
    return folder.children.reduce(
        (count, child) => count + (child.type === "file" ? 1 : fileCount(child)),
        0,
    );
}

/**
 * Bounds large commit trees; small trees retain the original DOM and pixel layout unless
 * `virtualize` says the panel around them is large.
 */
export function VirtualFileTreeRows({
    virtualize = false,
    ...props
}: FileTreeRowsProps<WorkingFile> & { virtualize?: boolean }): React.ReactElement {
    const root = useRef<HTMLDivElement>(null);
    const rows = useMemo(
        () => visibleCommitRows(props.entries, props.isDirectoryExpanded, props.depth),
        [props.depth, props.entries, props.isDirectoryExpanded],
    );
    const [windowRange, setWindowRange] = useState({ start: 0, end: 40 });
    const virtual = virtualize || rows.length > VIRTUAL_THRESHOLD;

    useLayoutEffect(() => {
        const element = root.current;
        if (!virtual || !element) return;
        const parent = scrollParent(element);
        let frame = 0;
        const measure = (): void => {
            frame = 0;
            const offset =
                element.getBoundingClientRect().top -
                parent.getBoundingClientRect().top +
                parent.scrollTop;
            const top = parent.scrollTop - offset;
            const bottom = top + (parent.clientHeight || 400);
            const start = Math.min(
                rows.length,
                Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN),
            );
            const end = Math.min(
                rows.length,
                Math.max(start, Math.ceil(bottom / ROW_HEIGHT) + OVERSCAN),
            );
            setWindowRange((previous) =>
                previous.start === start && previous.end === end ? previous : { start, end },
            );
        };
        const schedule = (): void => {
            if (!frame) frame = requestAnimationFrame(measure);
        };
        measure();
        parent.addEventListener("scroll", schedule, { passive: true });
        const observer =
            typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
        observer?.observe(parent);
        observer?.observe(element);
        return () => {
            parent.removeEventListener("scroll", schedule);
            observer?.disconnect();
            if (frame) cancelAnimationFrame(frame);
        };
    }, [rows.length, virtual]);

    if (!virtual) return <FileTreeRows {...props} />;
    const onKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
        if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") return;
        const wrapper = (event.target as Element).closest<HTMLElement>("[data-virtual-row-index]");
        if (!wrapper || !root.current) return;
        const current = Number(wrapper.dataset.virtualRowIndex);
        const entry = rows[current]?.entry;
        if (event.target === wrapper && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            if (entry?.type === "folder") props.onToggleDirectory(entry.path);
            else if (entry?.type === "file") {
                const wiring = props.fileWiring(entry.file, rows[current].depth);
                if (event.key === " ") wiring.onToggleCheck?.(entry.file.path);
                else (wiring.onActivate ?? wiring.onSelect)();
            }
            return;
        }
        const parent = scrollParent(root.current);
        const page = Math.max(1, Math.floor((parent.clientHeight || 400) / ROW_HEIGHT));
        const targets: Record<string, number> = {
            ArrowDown: current + 1,
            ArrowUp: current - 1,
            Home: 0,
            End: rows.length - 1,
            PageDown: current + page,
            PageUp: current - page,
        };
        if (!Object.hasOwn(targets, event.key)) return;
        const target = Math.min(rows.length - 1, Math.max(0, targets[event.key]));
        event.preventDefault();
        event.stopPropagation();
        const offset =
            root.current.getBoundingClientRect().top -
            parent.getBoundingClientRect().top +
            parent.scrollTop;
        parent.scrollTop = offset + target * ROW_HEIGHT;
        parent.dispatchEvent(new Event("scroll"));
        const focus = (attempt: number): void => {
            const row = root.current?.querySelector<HTMLElement>(
                `[data-virtual-row-index="${target}"]`,
            );
            if (row)
                (row.querySelector<HTMLElement>('[tabindex="0"], button, input') ?? row).focus();
            else if (attempt < 4) requestAnimationFrame(() => focus(attempt + 1));
        };
        requestAnimationFrame(() => focus(0));
    };
    return (
        <div
            ref={root}
            data-testid="virtual-commit-tree"
            style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}
            onKeyDownCapture={onKeyDown}
        >
            {rows.slice(windowRange.start, windowRange.end).map(({ entry, depth }, offset) => {
                const index = windowRange.start + offset;
                const key =
                    entry.type === "file"
                        ? (props.fileRowKey?.(entry.file) ?? entry.file.path)
                        : entry.path;
                return (
                    <div
                        key={key}
                        data-virtual-row-index={index}
                        tabIndex={index === windowRange.start ? 0 : -1}
                        style={{
                            position: "absolute",
                            top: index * ROW_HEIGHT,
                            height: ROW_HEIGHT,
                            width: "100%",
                        }}
                    >
                        {entry.type === "file" ? (
                            <TreeFileRow
                                file={entry.file}
                                depth={depth}
                                showParentPath={props.showParentPath}
                                ariaLevel={
                                    props.ariaLevel === undefined
                                        ? undefined
                                        : props.ariaLevel + depth
                                }
                                indentMetrics={props.indentMetrics}
                                rowVariant={props.rowVariant}
                                wiring={props.fileWiring(entry.file, depth)}
                            />
                        ) : (
                            <TreeFolderRow
                                folder={entry}
                                depth={depth}
                                isExpanded={props.isDirectoryExpanded(entry.path)}
                                fileCount={fileCount(entry)}
                                folderIcon={props.folderIcon}
                                folderExpandedIcon={props.folderExpandedIcon}
                                folderIconsByName={props.folderIconsByName}
                                ariaLevel={
                                    props.ariaLevel === undefined
                                        ? undefined
                                        : props.ariaLevel + depth
                                }
                                indentMetrics={props.indentMetrics}
                                rowVariant={props.rowVariant}
                                onToggleDirectory={props.onToggleDirectory}
                                wiring={props.folderWiring?.(entry)}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}
