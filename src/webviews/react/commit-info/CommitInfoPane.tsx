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

interface FileStats {
    additions: number;
    deletions: number;
}

interface CommitScopedExpandedDirs {
    commitHash: string | null;
    dirs: Set<string>;
}

interface CommitScopedSelection {
    commitHash: string | null;
    path: string | null;
}

interface CommitInfoPaneProps {
    detail: CommitDetail | null;
    loading?: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onOpenDiff?: (commitHash: string, filePath: string) => void;
}

const INFO_INDENT_BASE = 18;
const INFO_INDENT_STEP = 14;
const INFO_GUIDE_BASE = INFO_INDENT_BASE + 16 / 2;
const INFO_SECTION_GUIDE = 8 + 16 / 2;
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

function sumCommitFileStats(files: CommitFile[]): FileStats {
    return files.reduce<FileStats>(
        (stats, file) => ({
            additions: stats.additions + file.additions,
            deletions: stats.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
    );
}

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
}: CommitInfoPaneProps): React.ReactElement {
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

    const toggleFilesCollapsed = useCallback(() => {
        setFilesCollapsed((value) => !value);
    }, []);

    const toggleDetailCollapsed = useCallback(() => {
        setDetailCollapsed((value) => !value);
    }, []);

    if (!detail) {
        return loading ? (
            <CommitInfoLoadingPane bottomHeight={bottomHeight} />
        ) : (
            <NoCommitSelection />
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
            <CommitChangedFilesPanel
                detail={detail}
                tree={tree}
                expandedDirs={expandedDirs}
                selectedFilePath={selectedFilePath}
                filesCollapsed={filesCollapsed}
                folderIcon={folderIcon}
                folderExpandedIcon={folderExpandedIcon}
                folderIconsByName={folderIconsByName}
                onToggleFiles={toggleFilesCollapsed}
                onToggleDir={toggleDir}
                onSelectFile={selectFile}
                onOpenDiff={onOpenDiff}
            />
            <CommitResizeDivider
                visible={!filesCollapsed && !detailCollapsed}
                onMouseDown={onResizeStart}
            />
            <CommitDetailsPanel
                detail={detail}
                branchRefs={branchRefs}
                tagRefs={tagRefs}
                filesCollapsed={filesCollapsed}
                detailCollapsed={detailCollapsed}
                bottomHeight={bottomHeight}
                onToggleDetail={toggleDetailCollapsed}
            />
        </Flex>
    );
}

function CommitInfoLoadingPane({ bottomHeight }: { bottomHeight: number }): React.ReactElement {
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
            <SectionHeader
                label={t("commitInfo.changedFiles")}
                expanded={true}
                borderBottom={true}
            />
            <LoadingSection label={`${t("common.loading")} ${t("commitInfo.changedFiles")}`} />
            <Box flex="0 0 5px" bg={JETBRAINS_UI.color.divider} />
            <Box flexShrink={0} h={`${bottomHeight}px`} overflow="hidden">
                <SectionHeader label={t("commitInfo.details")} expanded={true} />
                <LoadingSection
                    label={`${t("common.loading")} ${t("commitInfo.details")}`}
                    h={`calc(100% - 28px)`}
                    flex="0 0 auto"
                />
            </Box>
        </Flex>
    );
}

function NoCommitSelection(): React.ReactElement {
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

function LoadingSection({
    label,
    flex = "1 1 auto",
    h,
}: {
    label: string;
    flex?: string;
    h?: string;
}): React.ReactElement {
    return (
        <Box
            flex={flex}
            h={h}
            minH="40px"
            display="flex"
            alignItems="center"
            justifyContent="center"
            position="relative"
            role="status"
            aria-live="polite"
        >
            <Box as="span" style={VISUALLY_HIDDEN_STYLE}>
                {label}
            </Box>
            <LoadingSpinner />
        </Box>
    );
}

function SectionHeader({
    label,
    expanded,
    onToggle,
    stats,
    borderBottom = false,
}: {
    label: string;
    expanded: boolean;
    onToggle?: () => void;
    stats?: FileStats;
    borderBottom?: boolean;
}): React.ReactElement {
    return (
        <Box
            display="flex"
            alignItems="center"
            px="8px"
            py="4px"
            fontWeight={600}
            fontSize="12px"
            color={JETBRAINS_UI.color.muted}
            bg={JETBRAINS_UI.color.toolbar}
            borderBottom={borderBottom ? `1px solid ${JETBRAINS_UI.color.border}` : undefined}
            cursor={onToggle ? "pointer" : undefined}
            tabIndex={onToggle ? 0 : undefined}
            role={onToggle ? "button" : undefined}
            aria-expanded={onToggle ? expanded : undefined}
            onClick={onToggle}
            onKeyDown={
                onToggle
                    ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onToggle();
                          }
                      }
                    : undefined
            }
        >
            <ChevronIcon expanded={expanded} />
            <Box as="span">{label}</Box>
            {stats && (stats.additions > 0 || stats.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {stats.additions > 0 && (
                        <Box
                            as="span"
                            color="var(--intelligit-pycharm-added)"
                            mr={stats.deletions > 0 ? "4px" : "0"}
                        >
                            +{stats.additions}
                        </Box>
                    )}
                    {stats.deletions > 0 && (
                        <Box as="span" color="var(--intelligit-pycharm-deleted)">
                            -{stats.deletions}
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    );
}

function CommitChangedFilesPanel({
    detail,
    tree,
    expandedDirs,
    selectedFilePath,
    filesCollapsed,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleFiles,
    onToggleDir,
    onSelectFile,
    onOpenDiff,
}: {
    detail: CommitDetail;
    tree: TreeEntry[];
    expandedDirs: Set<string>;
    selectedFilePath: string | null;
    filesCollapsed: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onToggleFiles: () => void;
    onToggleDir: (path: string) => void;
    onSelectFile: (path: string) => void;
    onOpenDiff?: (commitHash: string, filePath: string) => void;
}): React.ReactElement {
    const stats = sumCommitFileStats(detail.files);

    return (
        <>
            <SectionHeader
                label={t("commitInfo.changedFiles")}
                expanded={!filesCollapsed}
                onToggle={onToggleFiles}
                stats={stats}
                borderBottom={true}
            />
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
                        onToggleDir={onToggleDir}
                        onSelectFile={onSelectFile}
                        onOpenDiff={onOpenDiff}
                    />
                </Box>
            )}
        </>
    );
}

function CommitResizeDivider({
    visible,
    onMouseDown,
}: {
    visible: boolean;
    onMouseDown: React.MouseEventHandler<HTMLDivElement>;
}): React.ReactElement | null {
    if (!visible) return null;

    return (
        <Box
            flex="0 0 5px"
            cursor="row-resize"
            bg={JETBRAINS_UI.color.divider}
            position="relative"
            _hover={{ bg: JETBRAINS_UI.color.focus }}
            onMouseDown={onMouseDown}
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
    );
}

function CommitDetailsPanel({
    detail,
    branchRefs,
    tagRefs,
    filesCollapsed,
    detailCollapsed,
    bottomHeight,
    onToggleDetail,
}: {
    detail: CommitDetail;
    branchRefs: string[];
    tagRefs: string[];
    filesCollapsed: boolean;
    detailCollapsed: boolean;
    bottomHeight: number;
    onToggleDetail: () => void;
}): React.ReactElement {
    return (
        <Box
            flexShrink={filesCollapsed ? 1 : 0}
            flexGrow={filesCollapsed ? 1 : 0}
            minH={filesCollapsed ? 0 : undefined}
            h={filesCollapsed ? undefined : detailCollapsed ? "30px" : `${bottomHeight}px`}
            overflow="hidden"
        >
            <SectionHeader
                label={t("commitInfo.details")}
                expanded={!detailCollapsed}
                onToggle={onToggleDetail}
            />
            {!detailCollapsed && (
                <CommitDetailsBody detail={detail} branchRefs={branchRefs} tagRefs={tagRefs} />
            )}
        </Box>
    );
}

function CommitDetailsBody({
    detail,
    branchRefs,
    tagRefs,
}: {
    detail: CommitDetail;
    branchRefs: string[];
    tagRefs: string[];
}): React.ReactElement {
    return (
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
            <Box color="var(--vscode-descriptionForeground)" fontSize="12px" lineHeight="1.5">
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
            <Box color="var(--vscode-descriptionForeground)" fontSize="12px" lineHeight="1.5">
                {t("commitInfo.emailOnDate", {
                    email: detail.email,
                    date: formatDateTime(detail.date),
                })}
            </Box>
            <CommitRefsSection branchRefs={branchRefs} tagRefs={tagRefs} />
            <Box
                color="var(--vscode-descriptionForeground)"
                fontSize="12px"
                lineHeight="1.5"
                mt="4px"
            >
                {t("commitInfo.filesChanged", { count: detail.files.length })}
            </Box>
        </Box>
    );
}

function CommitRefsSection({
    branchRefs,
    tagRefs,
}: {
    branchRefs: string[];
    tagRefs: string[];
}): React.ReactElement | null {
    if (branchRefs.length === 0 && tagRefs.length === 0) return null;

    return (
        <Box mt="14px">
            {branchRefs.length > 0 && (
                <CommitRefGroup
                    kind="branch"
                    label={t("common.branches")}
                    refs={branchRefs}
                    mb={tagRefs.length > 0 ? "10px" : "0"}
                />
            )}
            {tagRefs.length > 0 && (
                <CommitRefGroup kind="tag" label={t("common.tags")} refs={tagRefs} />
            )}
        </Box>
    );
}

function CommitRefGroup({
    kind,
    label,
    refs,
    mb,
}: {
    kind: "branch" | "tag";
    label: string;
    refs: string[];
    mb?: string;
}): React.ReactElement {
    return (
        <Box mb={mb}>
            <Box
                color="var(--vscode-descriptionForeground)"
                fontSize="11px"
                mb="4px"
                opacity={0.85}
            >
                {label}
            </Box>
            <Flex direction="column" gap="3px">
                {refs.map((ref) => (
                    <CommitRefRow
                        key={kind === "tag" ? `tag:${ref}` : ref}
                        kind={kind}
                        name={ref}
                    />
                ))}
            </Flex>
        </Box>
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
