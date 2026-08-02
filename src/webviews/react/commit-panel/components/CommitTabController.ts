import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
    AmendBranchCommitSummary,
    ThemeFolderIconMap,
    ThemeTreeIcon,
    WorkingFile,
} from "../../../../types";
import { t } from "../../shared/i18n";
import type { MenuItem } from "../../shared/components/ContextMenu";
import type { ShelveDialogSubmit } from "./ShelveDialog";
import type { CommitMessageGenerationStatus } from "./CommitArea";
import { getVsCodeApi } from "../hooks/useVsCodeApi";

const MIN_REFRESH_FEEDBACK_MS = 700;
let shelfRequestSequence = 0;

/** Creates a request identifier shared by a shelf save and its idempotency token. */
function nextShelfRequestId(): string {
    shelfRequestSequence += 1;
    return `shelf-${Date.now()}-${shelfRequestSequence}`;
}

/** Data and host-owned callbacks rendered by the commit-tab surface. */
export interface CommitTabProps {
    repositoryRoot?: string;
    files: WorkingFile[];
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    commitMessage: string;
    isAmend: boolean;
    amendBranchCommits: AmendBranchCommitSummary[];
    amendBranchHistoryLoaded: boolean;
    isRefreshing: boolean;
    checkedPaths: Set<string>;
    onToggleFile: (path: string) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    onToggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onMessageChange: (message: string) => void;
    onAmendChange: (isAmend: boolean) => void;
    onCommit: () => void;
    canCommit: boolean;
    onPush: () => void;
    canPush: boolean;
    pushLabel: string;
    currentBranchAhead?: number;
    currentBranchName: string | null;
    currentBranchUpstream: string | null;
    /** Shared generation contract; optional until the docked and undocked state slices are wired. */
    generationStatus?: CommitMessageGenerationStatus;
    onGenerateMessage?: () => void;
    onCancelGeneration?: () => void;
    hasCommits?: boolean;
    wholeIndexOperationInProgress?: boolean;
    activeOperation: "none" | "merge" | "cherry-pick" | "revert" | "rebase";
    rebaseControl: "owned" | "unowned" | "foreign" | undefined;
    groupByDir: boolean;
    showIgnoredFiles: boolean;
    onToggleGroupBy: () => void;
    onToggleShowIgnoredFiles: () => void;
    catalogGeneration: number;
    onShelfFileDragStart?: (
        event: React.DragEvent<HTMLElement>,
        file: WorkingFile,
        checkedPaths: ReadonlySet<string>,
    ) => void;
}

interface CommitTabState {
    expandAllSignal: number;
    collapseAllSignal: number;
    isRefreshFeedbackActive: boolean;
    shelfMenuPosition: { x: number; y: number } | null;
    isShelveDialogOpen: boolean;
    defaultShelfName: string;
}

type CommitTabAction =
    | { type: "expandAll" }
    | { type: "collapseAll" }
    | { type: "setRefreshFeedback"; value: boolean }
    | { type: "setShelfMenuPosition"; value: CommitTabState["shelfMenuPosition"] }
    | { type: "setShelveDialogOpen"; value: boolean }
    | { type: "setDefaultShelfName"; value: string };

const INITIAL_STATE: CommitTabState = {
    expandAllSignal: 0,
    collapseAllSignal: 0,
    isRefreshFeedbackActive: false,
    shelfMenuPosition: null,
    isShelveDialogOpen: false,
    defaultShelfName: "",
};

/** Updates the related transient state behind the commit toolbar and shelf menu. */
function commitTabReducer(state: CommitTabState, action: CommitTabAction): CommitTabState {
    switch (action.type) {
        case "expandAll":
            return { ...state, expandAllSignal: state.expandAllSignal + 1 };
        case "collapseAll":
            return { ...state, collapseAllSignal: state.collapseAllSignal + 1 };
        case "setRefreshFeedback":
            return { ...state, isRefreshFeedbackActive: action.value };
        case "setShelfMenuPosition":
            return { ...state, shelfMenuPosition: action.value };
        case "setShelveDialogOpen":
            return { ...state, isShelveDialogOpen: action.value };
        case "setDefaultShelfName":
            return { ...state, defaultShelfName: action.value };
    }
}

/** Callbacks and derived data needed to render the stateless commit-tab layout. */
export interface CommitTabController {
    expandAllSignal: number;
    collapseAllSignal: number;
    hasMergeConflicts: boolean;
    activeOperation: "none" | "merge" | "cherry-pick" | "revert" | "rebase";
    rebaseControl: "owned" | "unowned" | "foreign" | undefined;
    isRefreshFeedbackActive: boolean;
    shelfDialogFocusRef: React.MutableRefObject<HTMLElement | null>;
    shelfMenuItems: MenuItem[];
    shelfMenuPosition: { x: number; y: number } | null;
    shelvePaths: string[];
    isShelveDialogOpen: boolean;
    defaultShelfName: string;
    handleRefresh: () => void;
    handleRollback: () => void;
    handleStash: () => void;
    handleOpenShelfMenu: (event: React.MouseEvent<HTMLElement>) => void;
    handleSelectShelfMenuItem: (action: string) => void;
    handleShowDiff: () => void;
    handleAbortMerge: () => void;
    handleContinueRebase: () => void;
    handleAbortRebase: () => void;
    handleFileClick: (path: string) => void;
    handleTrackUnversionedFiles: (paths: string[]) => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    onCommitTabContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
    closeShelfMenu: () => void;
    closeShelveDialog: () => void;
    submitShelveDialog: (input: ShelveDialogSubmit) => void;
}

/** Owns transient commit-tab interaction state without coupling host-owned commit data. */
export function useCommitTabController(props: CommitTabProps): CommitTabController {
    const { repositoryRoot, files, commitMessage, isRefreshing, checkedPaths, catalogGeneration } =
        // Host refresh state starts the local 700 ms toolbar-feedback timer; it does not update parent state.
        // react-doctor-disable-next-line react-doctor/no-event-handler
        props;
    const vscode = getVsCodeApi();
    const [state, dispatch] = useReducer(commitTabReducer, INITIAL_STATE);
    const shelfDialogFocusRef = useRef<HTMLElement | null>(null);
    const refreshFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const hasMergeConflicts = files.some((file) => file.status === "U");
    const shelvePaths = useMemo(() => {
        const selected = Array.from(checkedPaths);
        return selected.length > 0 ? selected : files.map((file) => file.path);
    }, [checkedPaths, files]);
    const openShelfMenuAt = useCallback(
        (x: number, y: number): void => {
            dispatch({
                type: "setDefaultShelfName",
                value: commitMessage || t("shelf.defaultName"),
            });
            dispatch({ type: "setShelfMenuPosition", value: { x, y } });
        },
        [commitMessage],
    );
    const clearRefreshFeedbackTimer = useCallback((): void => {
        if (refreshFeedbackTimerRef.current) {
            clearTimeout(refreshFeedbackTimerRef.current);
            refreshFeedbackTimerRef.current = undefined;
        }
    }, []);
    const showRefreshFeedback = useCallback((): void => {
        clearRefreshFeedbackTimer();
        dispatch({ type: "setRefreshFeedback", value: true });
        refreshFeedbackTimerRef.current = setTimeout(() => {
            dispatch({ type: "setRefreshFeedback", value: false });
            refreshFeedbackTimerRef.current = undefined;
        }, MIN_REFRESH_FEEDBACK_MS);
    }, [clearRefreshFeedbackTimer]);

    useEffect(() => {
        if (isRefreshing) showRefreshFeedback();
    }, [isRefreshing, showRefreshFeedback]);
    useEffect(() => clearRefreshFeedbackTimer, [clearRefreshFeedbackTimer]);

    const handleRefresh = useCallback((): void => {
        showRefreshFeedback();
        vscode.postMessage({ type: "refresh", ...(repositoryRoot ? { repositoryRoot } : {}) });
    }, [repositoryRoot, showRefreshFeedback, vscode]);
    const handleRollback = useCallback((): void => {
        vscode.postMessage({
            type: "rollback",
            ...(repositoryRoot ? { repositoryRoot } : {}),
            paths: Array.from(checkedPaths),
        });
    }, [repositoryRoot, vscode, checkedPaths]);
    const handleStash = useCallback((): void => {
        const selected = Array.from(checkedPaths);
        vscode.postMessage({
            type: "stashSave",
            ...(repositoryRoot ? { repositoryRoot } : {}),
            paths: selected.length > 0 ? selected : undefined,
        });
    }, [repositoryRoot, vscode, checkedPaths]);
    const handleShelve = useCallback(
        (input: ShelveDialogSubmit, silent: boolean, keepLocal: boolean): void => {
            if (input.paths.length === 0) return;
            const requestId = nextShelfRequestId();
            vscode.postMessage({
                type: "shelveSave",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                requestId,
                name: input.name,
                paths: input.paths,
                silent,
                keepLocal,
                idempotencyToken: requestId,
                expectedCatalogGeneration: catalogGeneration,
            });
        },
        [catalogGeneration, repositoryRoot, vscode],
    );
    const handleOpenShelfMenu = useCallback(
        (event: React.MouseEvent<HTMLElement>): void => {
            shelfDialogFocusRef.current = event.currentTarget;
            const rect = event.currentTarget.getBoundingClientRect();
            openShelfMenuAt(rect.left, rect.bottom + 4);
        },
        [openShelfMenuAt],
    );
    const shelfMenuItems = useMemo<MenuItem[]>(
        () => [
            {
                label: t("shelf.action.shelveChangesMenu"),
                action: "openDialog",
                disabled: shelvePaths.length === 0,
            },
            {
                label: t("shelf.action.shelveSilently"),
                action: "silent",
                disabled: shelvePaths.length === 0,
            },
            {
                label: t("shelf.action.save"),
                action: "keepLocal",
                disabled: shelvePaths.length === 0,
            },
        ],
        [shelvePaths.length],
    );
    const handleSelectShelfMenuItem = useCallback(
        (action: string): void => {
            dispatch({ type: "setShelfMenuPosition", value: null });
            if (action === "openDialog") dispatch({ type: "setShelveDialogOpen", value: true });
            if (action === "silent")
                handleShelve({ name: state.defaultShelfName, paths: shelvePaths }, true, false);
            if (action === "keepLocal")
                handleShelve({ name: state.defaultShelfName, paths: shelvePaths }, false, true);
        },
        [handleShelve, shelvePaths, state.defaultShelfName],
    );
    const handleShowDiff = useCallback((): void => {
        const selected = Array.from(checkedPaths);
        if (selected.length > 0) {
            vscode.postMessage({
                type: "showDiff",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                path: selected[0],
            });
        }
    }, [repositoryRoot, vscode, checkedPaths]);
    const handleAbortMerge = useCallback((): void => {
        vscode.postMessage({ type: "abortMerge", ...(repositoryRoot ? { repositoryRoot } : {}) });
    }, [repositoryRoot, vscode]);
    const handleContinueRebase = useCallback((): void => {
        vscode.postMessage({
            type: "continueRebase",
            ...(repositoryRoot ? { repositoryRoot } : {}),
        });
    }, [repositoryRoot, vscode]);
    const handleAbortRebase = useCallback((): void => {
        vscode.postMessage({ type: "abortRebase", ...(repositoryRoot ? { repositoryRoot } : {}) });
    }, [repositoryRoot, vscode]);
    const handleFileClick = useCallback(
        (path: string): void => {
            vscode.postMessage({
                type: "showDiff",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                path,
            });
        },
        [repositoryRoot, vscode],
    );
    const handleTrackUnversionedFiles = useCallback(
        (paths: string[]): void => {
            vscode.postMessage({
                type: "trackUnversionedFiles",
                ...(repositoryRoot ? { repositoryRoot } : {}),
                paths,
            });
        },
        [repositoryRoot, vscode],
    );
    const onCommitTabContextMenu = useCallback(
        (event: React.MouseEvent<HTMLElement>): void => {
            // File rows contribute their own VS Code menu, and the commit editor keeps the
            // native one so its message box and buttons stay usable; shelving is a
            // file-list action and has no meaning over either.
            if (
                event.target instanceof Element &&
                event.target.closest("[data-vscode-context], [data-commit-area]")
            )
                return;
            event.preventDefault();
            openShelfMenuAt(event.clientX, event.clientY);
        },
        [openShelfMenuAt],
    );
    const closeShelfMenu = useCallback(
        (): void => dispatch({ type: "setShelfMenuPosition", value: null }),
        [],
    );
    const closeShelveDialog = useCallback(
        (): void => dispatch({ type: "setShelveDialogOpen", value: false }),
        [],
    );
    const submitShelveDialog = useCallback(
        (input: ShelveDialogSubmit): void => {
            handleShelve(input, false, false);
            dispatch({ type: "setShelveDialogOpen", value: false });
        },
        [handleShelve],
    );

    return {
        ...state,
        hasMergeConflicts,
        activeOperation: props.activeOperation,
        rebaseControl: props.rebaseControl,
        shelfDialogFocusRef,
        shelfMenuItems,
        shelvePaths,
        handleRefresh,
        handleRollback,
        handleStash,
        handleOpenShelfMenu,
        handleSelectShelfMenuItem,
        handleShowDiff,
        handleAbortMerge,
        handleContinueRebase,
        handleAbortRebase,
        handleFileClick,
        handleTrackUnversionedFiles,
        onExpandAll: () => dispatch({ type: "expandAll" }),
        onCollapseAll: () => dispatch({ type: "collapseAll" }),
        onCommitTabContextMenu,
        closeShelfMenu,
        closeShelveDialog,
        submitShelveDialog,
    };
}
