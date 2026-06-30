import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";
import { Box, Flex } from "@chakra-ui/react";
import type { CommitDetail, CommitFile, ThemeFolderIconMap, ThemeTreeIcon } from "../../../types";
import { formatDateTime } from "../shared/date";
import { FileTypeIcon } from "../commit-panel/components/FileTypeIcon";
import { StatusBadge } from "../commit-panel/components/StatusBadge";
import { useDragResize } from "../commit-panel/hooks/useDragResize";
import { RefTypeIcon } from "../shared/components/RefTypeIcon";
import { TreeFolderIcon } from "../shared/components/TreeIcons";
import { ChevronIcon } from "../shared/components/Icons";
import { resolveFolderIcon } from "../shared/utils/folderIcons";
import { getLeafName } from "../shared/utils/path";
import { splitCommitRefs } from "../shared/utils/refs";
import { JETBRAINS_UI } from "../shared/tokens";
import { t } from "../shared/i18n";
import {
    buildFileTree,
    collectDirPaths,
    countFiles,
    type TreeEntry as GenericTreeEntry,
    type TreeFolder as GenericTreeFolder,
} from "../shared/fileTree";

type TreeEntry = GenericTreeEntry<CommitFile>;
type TreeFolder = GenericTreeFolder<CommitFile>;

interface CommitScopedExpandedDirs {
    commitHash: string | null;
    dirs: Set<string>;
}

interface CommitScopedSelection {
    commitHash: string | null;
    path: string | null;
}

const INFO_INDENT_BASE = 18;
const INFO_INDENT_STEP = 14;
const INFO_GUIDE_BASE = 23;
const INFO_SECTION_GUIDE = 7;
const SPIN_KEYFRAMES = `@keyframes intelligit-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
const VISUALLY_HIDDEN_STYLE: React.CSSProperties = {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
};

function CommitRefRow({
    kind,
    name,
}: {
    kind: "branch" | "tag";
    name: string;
}): React.ReactElement {
    return (
        <Flex
            align="center"
            gap="6px"
            fontSize="11px"
            lineHeight="16px"
            color="var(--vscode-foreground)"
            title={name}
        >
            <Box as="span" display="inline-flex" flexShrink={0}>
                <RefTypeIcon kind={kind} size={12} />
            </Box>
            <Box
                as="span"
                maxW="300px"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
            >
                {name}
            </Box>
        </Flex>
    );
}

/**
 * Displays the selected commit's changed-file tree and metadata, keeping file
 * expansion and selection scoped to the active commit hash.
 */
export function CommitInfoPane({
    detail,
    loading = false,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onOpenDiff,
}: {
    detail: CommitDetail | null;
    loading?: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onOpenDiff?: (commitHash: string, filePath: string) => void;
}): React.ReactElement {
    const [expandedDirsState, setExpandedDirsState] = useState<CommitScopedExpandedDirs>({
        commitHash: null,
        dirs: new Set(),
    });
    const [filesCollapsed, setFilesCollapsed] = useState(false);
    const [detailCollapsed, setDetailCollapsed] = useState(false);
    const [selectedFileState, setSelectedFileState] = useState<CommitScopedSelection>({
        commitHash: null,
        path: null,
    });
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

    const detailHash = detail?.hash ?? null;
    const tree = useMemo(() => buildFileTree(detail?.files ?? []), [detail?.files]);
    const defaultExpandedDirs = useMemo(() => new Set(collectDirPaths(tree)), [tree]);
    const expandedDirs =
        expandedDirsState.commitHash === detailHash ? expandedDirsState.dirs : defaultExpandedDirs;
    const selectedFilePath =
        selectedFileState.commitHash === detailHash &&
        selectedFileState.path &&
        detail?.files.some((file) => file.path === selectedFileState.path)
            ? selectedFileState.path
            : null;
    const { branches: branchRefs, tags: tagRefs } = useMemo(
        () => splitCommitRefs(detail?.refs ?? []),
        [detail?.refs],
    );

    const toggleDir = useCallback(
        (dir: string) => {
            setExpandedDirsState((prev) => {
                const currentDirs =
                    prev.commitHash === detailHash ? prev.dirs : defaultExpandedDirs;
                const next = new Set(currentDirs);
                if (next.has(dir)) next.delete(dir);
                else next.add(dir);
                return { commitHash: detailHash, dirs: next };
            });
        },
        [defaultExpandedDirs, detailHash],
    );

    const selectFile = useCallback(
        (path: string) => {
            setSelectedFileState({ commitHash: detailHash, path });
        },
        [detailHash],
    );

    if (!detail) {
        if (loading) {
            return (
                <Flex
                    direction="column"
                    h="100%"
                    overflow="hidden"
                    bg={JETBRAINS_UI.color.panel}
                    color="var(--vscode-descriptionForeground)"
                    fontFamily={SYSTEM_FONT_STACK}
                    fontSize="13px"
                >
                    <style>{SPIN_KEYFRAMES}</style>
                    <Box
                        display="flex"
                        alignItems="center"
                        px="8px"
                        py="4px"
                        fontWeight={600}
                        fontSize="12px"
                        color={JETBRAINS_UI.color.muted}
                        bg={JETBRAINS_UI.color.toolbar}
                        borderBottom={`1px solid ${JETBRAINS_UI.color.border}`}
                    >
                        <ChevronIcon expanded={true} /> {t("commitInfo.changedFiles")}
                    </Box>
                    <Box
                        flex="1 1 auto"
                        minH="40px"
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        position="relative"
                        role="status"
                        aria-live="polite"
                    >
                        <Box as="span" style={VISUALLY_HIDDEN_STYLE}>
                            {t("common.loading")} {t("commitInfo.changedFiles")}
                        </Box>
                        <LoadingSpinner />
                    </Box>
                    <Box flex="0 0 5px" bg={JETBRAINS_UI.color.divider} />
                    <Box flexShrink={0} h={`${bottomHeight}px`} overflow="hidden">
                        <Box
                            display="flex"
                            alignItems="center"
                            px="8px"
                            py="4px"
                            fontWeight={600}
                            fontSize="12px"
                            color={JETBRAINS_UI.color.muted}
                            bg={JETBRAINS_UI.color.toolbar}
                        >
                            <ChevronIcon expanded={true} /> {t("commitInfo.details")}
                        </Box>
                        <Box
                            h={`calc(100% - 28px)`}
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            position="relative"
                            role="status"
                            aria-live="polite"
                        >
                            <Box as="span" style={VISUALLY_HIDDEN_STYLE}>
                                {t("common.loading")} {t("commitInfo.details")}
                            </Box>
                            <LoadingSpinner />
                        </Box>
                    </Box>
                </Flex>
            );
        }

        return (
            <Box
                p="8px 12px"
                color="var(--vscode-descriptionForeground)"
                fontFamily={SYSTEM_FONT_STACK}
                fontSize="13px"
                h="100%"
                overflow="auto"
                display="flex"
                alignItems="flex-start"
                justifyContent="flex-start"
            >
                {t("commitInfo.noSelection")}
            </Box>
        );
    }

    return (
        <Flex
            ref={containerRef}
            direction="column"
            h="100%"
            overflow="hidden"
            bg={JETBRAINS_UI.color.panel}
        >
            <Box
                display="flex"
                alignItems="center"
                px="8px"
                py="4px"
                fontWeight={600}
                fontSize="12px"
                color={JETBRAINS_UI.color.muted}
                bg={JETBRAINS_UI.color.toolbar}
                borderBottom={`1px solid ${JETBRAINS_UI.color.border}`}
                cursor="pointer"
                tabIndex={0}
                role="button"
                aria-expanded={!filesCollapsed}
                onClick={() => setFilesCollapsed((v) => !v)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setFilesCollapsed((v) => !v);
                    }
                }}
            >
                <ChevronIcon expanded={!filesCollapsed} /> {t("commitInfo.changedFiles")}
            </Box>
            {!filesCollapsed && (
                <Box flex="1 1 auto" overflowY="auto" minH="40px" py="4px">
                    <TreeRows
                        entries={tree}
                        depth={0}
                        commitHash={detail.hash}
                        commitShortHash={detail.shortHash}
                        expandedDirs={expandedDirs}
                        selectedFilePath={selectedFilePath}
                        folderIcon={folderIcon}
                        folderExpandedIcon={folderExpandedIcon}
                        folderIconsByName={folderIconsByName}
                        onToggleDir={toggleDir}
                        onSelectFile={selectFile}
                        onOpenDiff={onOpenDiff}
                    />
                </Box>
            )}

            {!filesCollapsed && !detailCollapsed && (
                <Box
                    flex="0 0 5px"
                    cursor="row-resize"
                    bg={JETBRAINS_UI.color.divider}
                    position="relative"
                    _hover={{ bg: JETBRAINS_UI.color.focus }}
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
            )}

            <Box
                flexShrink={filesCollapsed ? 1 : 0}
                flexGrow={filesCollapsed ? 1 : 0}
                minH={filesCollapsed ? 0 : undefined}
                h={filesCollapsed ? undefined : detailCollapsed ? "30px" : `${bottomHeight}px`}
                overflow="hidden"
            >
                <Box
                    display="flex"
                    alignItems="center"
                    px="8px"
                    py="4px"
                    fontWeight={600}
                    fontSize="12px"
                    color={JETBRAINS_UI.color.muted}
                    bg={JETBRAINS_UI.color.toolbar}
                    cursor="pointer"
                    tabIndex={0}
                    role="button"
                    aria-expanded={!detailCollapsed}
                    onClick={() => setDetailCollapsed((v) => !v)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setDetailCollapsed((v) => !v);
                        }
                    }}
                >
                    <ChevronIcon expanded={!detailCollapsed} /> {t("commitInfo.details")}
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
                            {t("commitInfo.byAuthor", { author: detail.author })}
                        </Box>
                        <Box
                            color="var(--vscode-descriptionForeground)"
                            fontSize="12px"
                            lineHeight="1.5"
                        >
                            {t("commitInfo.emailOnDate", {
                                email: detail.email,
                                date: formatDateTime(detail.date),
                            })}
                        </Box>
                        {(branchRefs.length > 0 || tagRefs.length > 0) && (
                            <Box mt="14px">
                                {branchRefs.length > 0 && (
                                    <Box mb={tagRefs.length > 0 ? "10px" : "0"}>
                                        <Box
                                            color="var(--vscode-descriptionForeground)"
                                            fontSize="11px"
                                            mb="4px"
                                            opacity={0.85}
                                        >
                                            {t("common.branches")}
                                        </Box>
                                        <Flex direction="column" gap="3px">
                                            {branchRefs.map((ref) => (
                                                <CommitRefRow key={ref} kind="branch" name={ref} />
                                            ))}
                                        </Flex>
                                    </Box>
                                )}
                                {tagRefs.length > 0 && (
                                    <Box>
                                        <Box
                                            color="var(--vscode-descriptionForeground)"
                                            fontSize="11px"
                                            mb="4px"
                                            opacity={0.85}
                                        >
                                            {t("common.tags")}
                                        </Box>
                                        <Flex direction="column" gap="3px">
                                            {tagRefs.map((tag) => (
                                                <CommitRefRow
                                                    key={`tag:${tag}`}
                                                    kind="tag"
                                                    name={tag}
                                                />
                                            ))}
                                        </Flex>
                                    </Box>
                                )}
                            </Box>
                        )}
                        <Box
                            color="var(--vscode-descriptionForeground)"
                            fontSize="12px"
                            lineHeight="1.5"
                            mt="4px"
                        >
                            {t("commitInfo.filesChanged", { count: detail.files.length })}
                        </Box>
                    </Box>
                )}
            </Box>
        </Flex>
    );
}

function LoadingSpinner(): React.ReactElement {
    return (
        <svg
            width={18}
            height={18}
            viewBox="0 0 24 24"
            aria-hidden="true"
            style={{
                animation: "intelligit-spin 0.8s linear infinite",
                color: "var(--vscode-charts-yellow, #e5c07b)",
                transformBox: "fill-box",
                transformOrigin: "center",
                willChange: "transform",
            }}
        >
            <path
                fill="currentColor"
                d="M12,23a9.63,9.63,0,0,1-8-9.5,9.51,9.51,0,0,1,6.79-9.1A1.66,1.66,0,0,0,12,2.81h0a1.67,1.67,0,0,0-1.94-1.64A11,11,0,0,0,12,23Z"
            />
        </svg>
    );
}

function TreeRows({
    entries,
    depth,
    commitHash,
    commitShortHash,
    expandedDirs,
    selectedFilePath,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleDir,
    onSelectFile,
    onOpenDiff,
}: {
    entries: TreeEntry[];
    depth: number;
    commitHash: string;
    commitShortHash: string;
    expandedDirs: Set<string>;
    selectedFilePath: string | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onToggleDir: (path: string) => void;
    onSelectFile: (path: string) => void;
    onOpenDiff?: (commitHash: string, filePath: string) => void;
}): React.ReactElement {
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    return (
                        <CommitFileRow
                            key={entry.file.path}
                            file={entry.file}
                            depth={depth}
                            commitHash={commitHash}
                            commitShortHash={commitShortHash}
                            isSelected={selectedFilePath === entry.file.path}
                            onSelect={onSelectFile}
                            onOpenDiff={onOpenDiff}
                        />
                    );
                }
                const isExpanded = expandedDirs.has(entry.path);
                const fileCount = countFiles(entry.children);
                return (
                    <React.Fragment key={entry.path}>
                        <CommitFolderRow
                            folder={entry}
                            depth={depth}
                            isExpanded={isExpanded}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            fileCount={fileCount}
                            onToggle={() => onToggleDir(entry.path)}
                        />
                        {isExpanded && (
                            <TreeRows
                                entries={entry.children}
                                depth={depth + 1}
                                commitHash={commitHash}
                                commitShortHash={commitShortHash}
                                expandedDirs={expandedDirs}
                                selectedFilePath={selectedFilePath}
                                folderIcon={folderIcon}
                                folderExpandedIcon={folderExpandedIcon}
                                folderIconsByName={folderIconsByName}
                                onToggleDir={onToggleDir}
                                onSelectFile={onSelectFile}
                                onOpenDiff={onOpenDiff}
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
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    fileCount,
    onToggle,
}: {
    folder: TreeFolder;
    depth: number;
    isExpanded: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    fileCount: number;
    onToggle: () => void;
}): React.ReactElement {
    const padLeft = INFO_INDENT_BASE + depth * INFO_INDENT_STEP;
    const resolvedIcon = resolveFolderIcon(
        folder.path || folder.name,
        isExpanded,
        folderIconsByName,
        folderIcon,
        folderExpandedIcon,
    );
    return (
        <Flex
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            _hover={{ bg: JETBRAINS_UI.color.hover }}
            onClick={onToggle}
            title={folder.path}
        >
            <InfoIndentGuides treeDepth={depth} />
            <ChevronIcon expanded={isExpanded} />
            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
            <Box as="span" flex={1} opacity={0.85}>
                {folder.name}
            </Box>
            <Box as="span" ml="auto" fontSize="11px" color="var(--vscode-descriptionForeground)">
                {t("common.fileCount", { count: fileCount })}
            </Box>
        </Flex>
    );
}

const CommitFileRow = React.memo(function CommitFileRow({
    file,
    depth,
    commitHash,
    commitShortHash,
    isSelected,
    onSelect,
    onOpenDiff,
}: {
    file: CommitFile;
    depth: number;
    commitHash: string;
    commitShortHash: string;
    isSelected: boolean;
    onSelect: (path: string) => void;
    onOpenDiff?: (commitHash: string, filePath: string) => void;
}): React.ReactElement {
    const padLeft = INFO_INDENT_BASE + depth * INFO_INDENT_STEP;
    const fileName = getLeafName(file.path);
    const rowRef = useRef<HTMLDivElement>(null);

    const openDiff = useCallback(() => {
        onOpenDiff?.(commitHash, file.path);
    }, [onOpenDiff, commitHash, file.path]);

    const selectRow = useCallback(() => {
        onSelect(file.path);
    }, [onSelect, file.path]);

    useEffect(() => {
        const el = rowRef.current;
        if (!el) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                openDiff();
            } else if (e.key === " " || e.code === "Space") {
                e.preventDefault();
                selectRow();
            }
        };
        el.addEventListener("keydown", handleKeyDown);
        return () => {
            el.removeEventListener("keydown", handleKeyDown);
        };
    }, [openDiff, selectRow]);

    const vscodeContext = useMemo(
        () =>
            JSON.stringify({
                webviewSection: "commitInfoFile",
                filePath: file.path,
                commitHash,
                commitShortHash,
                preventDefaultContextMenuItems: true,
            }),
        [file.path, commitHash, commitShortHash],
    );

    return (
        <Flex
            ref={rowRef}
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            tabIndex={0}
            role="treeitem"
            aria-selected={isSelected}
            bg={isSelected ? JETBRAINS_UI.color.selected : undefined}
            color={isSelected ? JETBRAINS_UI.color.selectedForeground : undefined}
            boxShadow={isSelected ? `inset 2px 0 0 ${JETBRAINS_UI.color.focus}` : undefined}
            _hover={{
                bg: isSelected ? JETBRAINS_UI.color.selected : JETBRAINS_UI.color.hover,
            }}
            _focusVisible={{
                outline: `1px solid ${JETBRAINS_UI.color.focus}`,
                outlineOffset: "-1px",
            }}
            data-vscode-context={vscodeContext}
            onClick={selectRow}
            onDoubleClick={openDiff}
            title={file.path}
        >
            <InfoIndentGuides treeDepth={depth} />
            <Box as="span" w="14px" flexShrink={0} />
            <FileTypeIcon status={file.status} icon={file.icon} />
            <Box as="span" flex={1} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                {fileName}
            </Box>
            {(file.additions > 0 || file.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {file.additions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-addedResourceForeground, #8bcf7b)"
                            mr="4px"
                        >
                            +{file.additions}
                        </Box>
                    )}
                    {file.deletions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-deletedResourceForeground, #d76f6f)"
                        >
                            -{file.deletions}
                        </Box>
                    )}
                </Box>
            )}
            <StatusBadge status={file.status} />
        </Flex>
    );
});

function InfoIndentGuides({ treeDepth }: { treeDepth: number }): React.ReactElement {
    return (
        <>
            <Box
                as="span"
                position="absolute"
                top={0}
                bottom={0}
                w="1px"
                bg="var(--vscode-tree-indentGuidesStroke, rgba(154, 169, 198, 0.22))"
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
                    bg="var(--vscode-tree-indentGuidesStroke, rgba(154, 169, 198, 0.22))"
                    left={`${INFO_GUIDE_BASE + i * INFO_INDENT_STEP}px`}
                />
            ))}
        </>
    );
}
