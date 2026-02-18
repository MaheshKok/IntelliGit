// The main Commit tab: toolbar + file tree + drag handle + commit area.
// Composes all commit-related sub-components into the commit workflow.

import React, { useRef, useState, useCallback } from "react";
import { Flex, Box } from "@chakra-ui/react";
import { Toolbar } from "./Toolbar";
import { FileTree } from "./FileTree";
import { CommitArea } from "./CommitArea";
import { useDragResize } from "../hooks/useDragResize";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type { WorkingFile } from "../../../../types";

interface Props {
    files: WorkingFile[];
    commitMessage: string;
    isAmend: boolean;
    checkedPaths: Set<string>;
    onToggleFile: (path: string) => void;
    onToggleFolder: (dirPrefix: string, files: WorkingFile[]) => void;
    onToggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onMessageChange: (message: string) => void;
    onAmendChange: (isAmend: boolean) => void;
    onCommit: () => void;
    onCommitAndPush: () => void;
}

export function CommitTab({
    files,
    commitMessage,
    isAmend,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    onToggleSection,
    isAllChecked,
    isSomeChecked,
    onMessageChange,
    onAmendChange,
    onCommit,
    onCommitAndPush,
}: Props): React.ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const { height: bottomHeight, onMouseDown: onDragMouseDown } = useDragResize(
        140,
        80,
        containerRef,
    );
    const [groupByDir, setGroupByDir] = useState(true);
    const [expandAllSignal, setExpandAllSignal] = useState(0);
    const [collapseAllSignal, setCollapseAllSignal] = useState(0);
    const vscode = getVsCodeApi();

    const handleRefresh = useCallback(() => {
        vscode.postMessage({ type: "refresh" });
    }, [vscode]);

    const handleRollback = useCallback(() => {
        vscode.postMessage({ type: "rollback", paths: Array.from(checkedPaths) });
    }, [vscode, checkedPaths]);

    const handleShelve = useCallback(() => {
        const selected = Array.from(checkedPaths);
        vscode.postMessage({
            type: "shelveSave",
            paths: selected.length > 0 ? selected : undefined,
        });
    }, [vscode, checkedPaths]);

    const handleShowDiff = useCallback(() => {
        const selected = Array.from(checkedPaths);
        if (selected.length > 0) {
            vscode.postMessage({ type: "showDiff", path: selected[0] });
        }
    }, [vscode, checkedPaths]);

    const handleFileClick = useCallback(
        (path: string) => {
            vscode.postMessage({ type: "showDiff", path });
        },
        [vscode],
    );

    return (
        <Flex ref={containerRef} direction="column" flex={1} overflow="hidden">
            <Toolbar
                onRefresh={handleRefresh}
                onRollback={handleRollback}
                onToggleGroupBy={() => setGroupByDir((g) => !g)}
                onShelve={handleShelve}
                onShowDiff={handleShowDiff}
                onExpandAll={() => setExpandAllSignal((s) => s + 1)}
                onCollapseAll={() => setCollapseAllSignal((s) => s + 1)}
            />

            <Box flex="1 1 auto" overflowY="auto" minH="40px">
                <FileTree
                    files={files}
                    groupByDir={groupByDir}
                    checkedPaths={checkedPaths}
                    onToggleFile={onToggleFile}
                    onToggleFolder={onToggleFolder}
                    onToggleSection={onToggleSection}
                    isAllChecked={isAllChecked}
                    isSomeChecked={isSomeChecked}
                    onFileClick={handleFileClick}
                    expandAllSignal={expandAllSignal}
                    collapseAllSignal={collapseAllSignal}
                />
            </Box>

            {/* Drag handle */}
            <Box
                flex="0 0 4px"
                cursor="row-resize"
                bg="var(--vscode-panel-border, #444)"
                position="relative"
                _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                onMouseDown={onDragMouseDown}
                _after={{
                    content: '""',
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    transform: "translate(-50%, -50%)",
                    w: "26px",
                    h: "2px",
                    bg: "var(--vscode-descriptionForeground)",
                    opacity: 0.35,
                    borderRadius: "1px",
                }}
            />

            {/* Bottom area */}
            <Box
                flexShrink={0}
                h={`${bottomHeight}px`}
                overflow="hidden"
                display="flex"
                flexDirection="column"
            >
                <CommitArea
                    commitMessage={commitMessage}
                    isAmend={isAmend}
                    onMessageChange={onMessageChange}
                    onAmendChange={onAmendChange}
                    onCommit={onCommit}
                    onCommitAndPush={onCommitAndPush}
                />
            </Box>
        </Flex>
    );
}
