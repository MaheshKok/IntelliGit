import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex } from "@chakra-ui/react";
import type { CommitDetail, CommitFile } from "../../../types";
import { formatDateTime } from "../shared/date";
import { FileTypeIcon } from "../commit-panel/components/FileTypeIcon";
import { StatusBadge } from "../commit-panel/components/StatusBadge";
import { useDragResize } from "../commit-panel/hooks/useDragResize";
import { REF_BADGE_COLORS } from "../shared/tokens";
import {
    buildFileTree,
    collectDirPaths,
    countFiles,
    type TreeEntry as GenericTreeEntry,
    type TreeFolder as GenericTreeFolder,
} from "../shared/fileTree";

type TreeEntry = GenericTreeEntry<CommitFile>;
type TreeFolder = GenericTreeFolder<CommitFile>;

const INFO_INDENT_BASE = 18;
const INFO_INDENT_STEP = 14;
const INFO_GUIDE_BASE = 23;
const INFO_SECTION_GUIDE = 7;

function CommitRefBadge({ name }: { name: string }): React.ReactElement {
    const isHead = name.includes("HEAD");
    const isTag = name.startsWith("tag:");
    let bg: string;
    let fg: string;

    if (isHead) {
        bg = REF_BADGE_COLORS.head.bg;
        fg = REF_BADGE_COLORS.head.fg;
    } else if (isTag) {
        bg = REF_BADGE_COLORS.tag.bg;
        fg = REF_BADGE_COLORS.tag.fg;
    } else if (name.startsWith("origin/")) {
        bg = REF_BADGE_COLORS.remote.bg;
        fg = REF_BADGE_COLORS.remote.fg;
    } else {
        bg = REF_BADGE_COLORS.local.bg;
        fg = REF_BADGE_COLORS.local.fg;
    }

    return (
        <Box
            as="span"
            px="6px"
            py="1px"
            borderRadius="3px"
            fontSize="10px"
            lineHeight="16px"
            color={fg}
            bg={bg}
            title={name}
            maxW="220px"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
        >
            {name}
        </Box>
    );
}

export function CommitInfoPane({ detail }: { detail: CommitDetail | null }): React.ReactElement {
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
    const [detailCollapsed, setDetailCollapsed] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const { height: bottomHeight, onMouseDown: onResizeStart } = useDragResize(
        220,
        70,
        containerRef,
        {
            maxReservedHeight: 80,
            onResize: () => setDetailCollapsed(false),
        },
    );

    const tree = useMemo(() => buildFileTree(detail?.files ?? []), [detail?.files]);

    useEffect(() => {
        if (!detail) {
            setExpandedDirs(new Set());
            return;
        }
        setExpandedDirs(new Set(collectDirPaths(tree)));
    }, [detail, tree]);

    if (!detail) {
        return (
            <Box
                p="8px 12px"
                color="var(--vscode-descriptionForeground)"
                fontFamily="var(--vscode-font-family)"
                fontSize="var(--vscode-font-size)"
                h="100%"
                overflow="auto"
            >
                No commit selected
            </Box>
        );
    }

    return (
        <Flex ref={containerRef} direction="column" h="100%" overflow="hidden">
            <Box
                px="8px"
                py="4px"
                fontWeight={600}
                fontSize="12px"
                color="var(--vscode-descriptionForeground)"
                borderBottom="1px solid var(--vscode-panel-border)"
            >
                Changed Files
            </Box>
            <Box flex="1 1 auto" overflowY="auto" minH="40px" py="4px">
                <TreeRows
                    entries={tree}
                    depth={0}
                    expandedDirs={expandedDirs}
                    onToggleDir={(dir) =>
                        setExpandedDirs((prev) => {
                            const next = new Set(prev);
                            if (next.has(dir)) next.delete(dir);
                            else next.add(dir);
                            return next;
                        })
                    }
                />
            </Box>

            <Box
                flex="0 0 5px"
                cursor="row-resize"
                bg="var(--vscode-panel-border, #444)"
                position="relative"
                _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                onMouseDown={onResizeStart}
                _after={{
                    content: '""',
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    transform: "translate(-50%, -50%)",
                    w: "30px",
                    h: "2px",
                    bg: "var(--vscode-descriptionForeground)",
                    opacity: 0.4,
                    borderRadius: "1px",
                }}
            />

            <Box
                flexShrink={0}
                h={detailCollapsed ? "30px" : `${bottomHeight}px`}
                overflow="hidden"
            >
                <Box
                    px="8px"
                    py="4px"
                    fontWeight={600}
                    fontSize="12px"
                    color="var(--vscode-descriptionForeground)"
                    cursor="pointer"
                    onClick={() => setDetailCollapsed((v) => !v)}
                >
                    {detailCollapsed ? "\u25B6" : "\u25BC"} Commit Details
                </Box>
                {!detailCollapsed && (
                    <Box px="12px" py="6px" overflowY="auto" h={`calc(100% - 28px)`}>
                        <Box fontWeight={600} whiteSpace="pre-wrap" lineHeight="1.4" mb="6px">
                            {detail.message}
                        </Box>
                        {detail.body && (
                            <Box
                                color="var(--vscode-descriptionForeground)"
                                whiteSpace="pre-wrap"
                                lineHeight="1.4"
                                mb="6px"
                            >
                                {detail.body}
                            </Box>
                        )}
                        <Box
                            color="var(--vscode-descriptionForeground)"
                            fontSize="12px"
                            lineHeight="1.5"
                        >
                            <span
                                style={{
                                    fontFamily: "var(--vscode-editor-font-family, monospace)",
                                    color: "var(--vscode-textLink-foreground)",
                                }}
                            >
                                {detail.shortHash}
                            </span>{" "}
                            by {detail.author}
                        </Box>
                        <Box
                            color="var(--vscode-descriptionForeground)"
                            fontSize="12px"
                            lineHeight="1.5"
                        >
                            {detail.email} on {formatDateTime(detail.date)}
                        </Box>
                        {detail.refs.length > 0 && (
                            <Box mt="6px">
                                <Box
                                    color="var(--vscode-descriptionForeground)"
                                    fontSize="11px"
                                    mb="4px"
                                    opacity={0.85}
                                >
                                    Labels
                                </Box>
                                <Flex wrap="wrap" gap="4px">
                                    {detail.refs.map((ref) => (
                                        <CommitRefBadge key={ref} name={ref} />
                                    ))}
                                </Flex>
                            </Box>
                        )}
                        <Box
                            color="var(--vscode-descriptionForeground)"
                            fontSize="12px"
                            lineHeight="1.5"
                            mt="4px"
                        >
                            {detail.files.length} file{detail.files.length !== 1 ? "s" : ""} changed
                        </Box>
                    </Box>
                )}
            </Box>
        </Flex>
    );
}

function TreeRows({
    entries,
    depth,
    expandedDirs,
    onToggleDir,
}: {
    entries: TreeEntry[];
    depth: number;
    expandedDirs: Set<string>;
    onToggleDir: (path: string) => void;
}): React.ReactElement {
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    return <CommitFileRow key={entry.file.path} file={entry.file} depth={depth} />;
                }
                const isExpanded = expandedDirs.has(entry.path);
                const fileCount = countFiles(entry.children);
                return (
                    <React.Fragment key={entry.path}>
                        <CommitFolderRow
                            folder={entry}
                            depth={depth}
                            isExpanded={isExpanded}
                            fileCount={fileCount}
                            onToggle={() => onToggleDir(entry.path)}
                        />
                        {isExpanded && (
                            <TreeRows
                                entries={entry.children}
                                depth={depth + 1}
                                expandedDirs={expandedDirs}
                                onToggleDir={onToggleDir}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}

function CommitFolderRow({
    folder,
    depth,
    isExpanded,
    fileCount,
    onToggle,
}: {
    folder: TreeFolder;
    depth: number;
    isExpanded: boolean;
    fileCount: number;
    onToggle: () => void;
}): React.ReactElement {
    const padLeft = INFO_INDENT_BASE + depth * INFO_INDENT_STEP;
    return (
        <Flex
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            lineHeight="22px"
            fontSize="13px"
            cursor="pointer"
            position="relative"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
            onClick={onToggle}
            title={folder.path}
        >
            <InfoIndentGuides treeDepth={depth} />
            <Box
                as="span"
                fontSize="11px"
                w="14px"
                textAlign="center"
                flexShrink={0}
                opacity={0.7}
                transform={isExpanded ? "rotate(90deg)" : undefined}
                transition="transform 0.15s ease"
                display="inline-block"
            >
                &#9654;
            </Box>
            <Box as="span" w="16px" h="16px" flexShrink={0}>
                <svg viewBox="0 0 16 16" width="16" height="16">
                    <path
                        fill="var(--vscode-icon-foreground, currentColor)"
                        d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.85A.5.5 0 0 0 6.5 2.5H1.5z"
                    />
                </svg>
            </Box>
            <Box as="span" flex={1} opacity={0.85}>
                {folder.name}
            </Box>
            <Box as="span" ml="auto" fontSize="11px" color="var(--vscode-descriptionForeground)">
                {fileCount} file{fileCount !== 1 ? "s" : ""}
            </Box>
        </Flex>
    );
}

function CommitFileRow({ file, depth }: { file: CommitFile; depth: number }): React.ReactElement {
    const padLeft = INFO_INDENT_BASE + depth * INFO_INDENT_STEP;
    const fileName = file.path.split("/").pop() ?? file.path;

    return (
        <Flex
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            lineHeight="22px"
            fontSize="13px"
            cursor="default"
            position="relative"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
            title={file.path}
        >
            <InfoIndentGuides treeDepth={depth} />
            <Box as="span" w="14px" flexShrink={0} />
            <FileTypeIcon filename={fileName} status={file.status} />
            <Box as="span" flex={1} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                {fileName}
            </Box>
            {(file.additions > 0 || file.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {file.additions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-addedResourceForeground, #2ea043)"
                            mr="4px"
                        >
                            +{file.additions}
                        </Box>
                    )}
                    {file.deletions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-deletedResourceForeground, #f85149)"
                        >
                            -{file.deletions}
                        </Box>
                    )}
                </Box>
            )}
            <StatusBadge status={file.status} />
        </Flex>
    );
}

function InfoIndentGuides({ treeDepth }: { treeDepth: number }): React.ReactElement {
    return (
        <>
            <Box
                as="span"
                position="absolute"
                top={0}
                bottom={0}
                w="1px"
                bg="var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.12))"
                left={`${INFO_SECTION_GUIDE}px`}
            />
            {Array.from({ length: treeDepth }, (_, i) => (
                <Box
                    key={i}
                    as="span"
                    position="absolute"
                    top={0}
                    bottom={0}
                    w="1px"
                    bg="var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.12))"
                    left={`${INFO_GUIDE_BASE + i * INFO_INDENT_STEP}px`}
                />
            ))}
        </>
    );
}
