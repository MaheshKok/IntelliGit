import React, { useCallback, useMemo, useRef, useState } from "react";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";
import { Box, Flex } from "@chakra-ui/react";
import type { CommitDetail, CommitFile, ThemeFolderIconMap, ThemeTreeIcon } from "../../../types";
import { formatDateTime } from "../shared/date";
import { useDragResize } from "../commit-panel/hooks/useDragResize";
import { RefTypeIcon } from "../shared/components/RefTypeIcon";
import { FileTreeRows } from "../shared/components/FileTreeRows";
import { SectionHeader } from "../shared/components/SectionHeader";
import { splitCommitRefs } from "../shared/utils/refs";
import { JETBRAINS_UI } from "../shared/tokens";
import { t } from "../shared/i18n";
import {
    buildFileTree,
    collectDirPaths,
    type TreeEntry as GenericTreeEntry,
} from "../shared/fileTree";

type TreeEntry = GenericTreeEntry<CommitFile>;

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
    /**
     * Whether a commit is selected on the same screen, independent of whether its detail has
     * arrived. Surfaces that show a graph beside this pane auto-select their newest commit and
     * then wait on the host for the detail; without this the pane cannot tell that window apart
     * from a genuinely empty selection and denies a row it is drawing as current. Left optional
     * and defaulting to false for the standalone commit-info view, which has no graph to disagree
     * with and mirrors the host's selection through `loading` alone.
     */
    hasSelection?: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onOpenDiff?: (commitHash: string, filePath: string) => void;
}

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
    hasSelection = false,
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
        // `hasSelection` counts as loading, not as an empty selection. A graph beside this pane
        // auto-selects its newest commit and only then asks the host for the detail, so between
        // those two moments a row is drawn `aria-current` while `loading` is still false --
        // and the host's own bare `clearCommitDetail` can arrive later still and clear a
        // transient flag, which is why the state is derived from the selection rather than
        // set at the moment of selecting. "No commit selected" is now reserved for the case
        // it describes.
        return loading || hasSelection ? (
            <CommitInfoLoadingPane bottomHeight={bottomHeight} />
        ) : (
            <NoCommitSelection />
        );
    }

    return (
        <Flex
            ref={containerRef}
            data-testid="commit-info-pane"
            data-pane-state="detail"
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
            data-testid="commit-info-pane"
            data-pane-state="loading"
            direction="column"
            h="100%"
            overflow="hidden"
            bg={JETBRAINS_UI.color.panel}
            color="var(--vscode-descriptionForeground)"
            fontFamily={SYSTEM_FONT_STACK}
            fontSize="13px"
        >
            <SectionHeader
                variant="commit-info"
                label={t("commitInfo.changedFiles")}
                expanded={true}
                borderBottom={true}
            />
            <LoadingSection label={`${t("common.loading")} ${t("commitInfo.changedFiles")}`} />
            <Box flex="0 0 5px" bg={JETBRAINS_UI.color.divider} />
            <Box flexShrink={0} h={`${bottomHeight}px`} overflow="hidden">
                <SectionHeader
                    variant="commit-info"
                    label={t("commitInfo.details")}
                    expanded={true}
                />
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
            data-testid="commit-info-pane"
            data-pane-state="empty"
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
            // Three bars plus gaps and padding need 66px. The details pane drags down to
            // 70px, so scroll the skeleton the way the loaded body does rather than let the
            // last bar be cut off by the section's own overflow:hidden.
            overflowY="auto"
            display="flex"
            flexDirection="column"
            gap="8px"
            p="10px 12px"
            role="status"
            aria-live="polite"
        >
            <Box as="span" style={VISUALLY_HIDDEN_STYLE}>
                {label}
            </Box>
            {SKELETON_BAR_WIDTHS.map((width) => (
                <Box key={width} style={{ ...SKELETON_BAR_STYLE, width }} />
            ))}
        </Box>
    );
}

/** Three static placeholder lines where the file rows and details will land. */
const SKELETON_BAR_WIDTHS = ["72%", "48%", "60%"] as const;
const SKELETON_BAR_STYLE: React.CSSProperties = {
    height: 10,
    borderRadius: JETBRAINS_UI.size.badgeRadius,
    background: `color-mix(in srgb, ${JETBRAINS_UI.color.foreground} 10%, transparent)`,
};

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
                variant="commit-info"
                label={t("commitInfo.changedFiles")}
                expanded={!filesCollapsed}
                onToggle={onToggleFiles}
                stats={stats}
                borderBottom={true}
            />
            {!filesCollapsed && (
                <Box flex="1 1 auto" overflowY="auto" minH="40px" py="4px">
                    <FileTreeRows
                        entries={tree}
                        depth={0}
                        folderIcon={folderIcon}
                        folderExpandedIcon={folderExpandedIcon}
                        folderIconsByName={folderIconsByName}
                        isDirectoryExpanded={(path) => expandedDirs.has(path)}
                        onToggleDirectory={onToggleDir}
                        fileWiring={(file) => ({
                            isSelected: selectedFilePath === file.path,
                            onSelect: () => onSelectFile(file.path),
                            onActivate: () => onOpenDiff?.(detail.hash, file.path),
                            vscodeContext: JSON.stringify({
                                webviewSection: "commitInfoFile",
                                filePath: file.path,
                                commitHash: detail.hash,
                                commitShortHash: detail.shortHash,
                                preventDefaultContextMenuItems: true,
                            }),
                        })}
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
                variant="commit-info"
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
