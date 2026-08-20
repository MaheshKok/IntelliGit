// Message bridge between the VS Code extension host and commit panel React app.

import { useCallback, useEffect, useReducer, useRef, type Dispatch } from "react";
import { getVsCodeApi } from "./useVsCodeApi";
import type {
    CommitPanelAction,
    CommitPanelRepositorySummary,
    InboundMessage,
    MultiRepositoryCommitPanelState,
    RepositoryCommitPanelState,
} from "../types";
import type { WorkingFile } from "../../../../types";
import { commitMessageGenerationPrefix } from "../../shared/commitMessageDraft";

const LEGACY_REPOSITORY_ROOT = "";

/**
 * How long to wait for the host's answer before asking to be hydrated again.
 *
 * The panel's only route to content is the `ready` handshake, and neither leg of it is
 * acknowledged: VS Code's `postMessage` resolves `false` for a webview that is not live, and its
 * contract states that even a `true` does not mean the message was received. A one-shot request
 * therefore turns any single dropped message into a permanently blank panel -- React mounted, no
 * repositories, no empty state, nothing to retry it. That reached CI as an intermittently blank
 * commit panel.
 */
const HYDRATION_RETRY_INTERVAL_MS = 1_000;

/**
 * How long the opening burst lasts before the retry drops to {@link HYDRATION_HEARTBEAT_MS}.
 *
 * Expressed in time rather than in attempts, because the delay being ridden out is the host's, and
 * a fixed attempt count silently becomes a much shorter deadline whenever the interval shrinks.
 */
const HYDRATION_BURST_MS = 15_000;

/**
 * How often to keep asking once the opening burst has gone unanswered.
 *
 * The retry does NOT stop. It used to, after this same fifteen seconds, and that was the whole
 * defect: an unhydrated panel has no other route to content -- `onDidChangeVisibility` re-posts the
 * working-tree snapshot but never the repository list, and `SET_FILES_AND_STASHES` deliberately
 * refuses to set `hydrated` -- so giving up turned one dropped message into a pane that stays blank
 * for as long as the editor is open. CI caught it as a commit panel that had mounted React,
 * rendered its placeholder, and fallen silent beside a fully populated host.
 *
 * Stopping was never the safeguard; the COST was. Every re-ask used to buy a full Git refresh,
 * which is unaffordable once per second forever. Numbering the attempts lets the host answer a
 * re-ask from state it already holds, and a slow heartbeat against that costs a message every few
 * seconds -- cheap enough that there is no longer any reason to abandon the panel.
 */
const HYDRATION_HEARTBEAT_MS = 5_000;

function createRepositoryState(
    root: string,
    label: string,
    kind: "repository" | "worktree" = "repository",
    changedFileCount: number = 0,
): RepositoryCommitPanelState {
    return {
        root,
        label,
        kind,
        changedFileCount,
        files: [],
        filesHydrated: false,
        stashes: [],
        stashFiles: [],
        selectedStashIndex: null,
        shelves: [],
        catalogGeneration: 0,
        selectedShelfId: null,
        shelfRemoveOnUnshelve: true,
        shelfHealth: [],
        shelfMutationOutcome: null,
        folderIcon: undefined,
        folderExpandedIcon: undefined,
        folderIconsByName: {},
        iconFonts: [],
        commitMessage: "",
        isAmend: false,
        amendBranchCommits: [],
        amendBranchHistoryLoaded: false,
        isRefreshing: false,
        error: null,
        currentBranchHasUpstream: true,
        hasRemotes: true,
        currentBranchAhead: 0,
        currentBranchBehind: 0,
        currentBranchName: null,
        currentBranchUpstream: null,
        generation: { status: "idle" },
        hasCommits: false,
        wholeIndexOperationInProgress: false,
    };
}

const initialState: MultiRepositoryCommitPanelState = {
    repositories: [],
    activeRepositoryRoot: null,
    expandedRepositoryRoots: [],
    hydrated: false,
};

function countChangedFiles(files: WorkingFile[]): number {
    const paths = new Set<string>();
    for (const file of files) {
        if (file.status !== "!") paths.add(file.path);
    }
    return paths.size;
}

function targetRoot(state: MultiRepositoryCommitPanelState, repositoryRoot?: string): string {
    return (
        repositoryRoot ??
        state.activeRepositoryRoot ??
        state.repositories[0]?.root ??
        LEGACY_REPOSITORY_ROOT
    );
}

function expandedRootsFor(
    state: MultiRepositoryCommitPanelState,
    repositories: CommitPanelRepositorySummary[],
    activeRepositoryRoot: string | null,
): string[] {
    const knownRoots = new Set(repositories.map((repository) => repository.root));
    const retained = state.expandedRepositoryRoots.filter((root) => knownRoots.has(root));
    if (retained.length > 0) return retained;
    if (state.repositories.length > 0) return [];
    const fallbackRoot = activeRepositoryRoot ?? repositories[0]?.root;
    return fallbackRoot ? [fallbackRoot] : [];
}

function updateRepository(
    state: MultiRepositoryCommitPanelState,
    repositoryRoot: string | undefined,
    update: (repository: RepositoryCommitPanelState) => RepositoryCommitPanelState,
): MultiRepositoryCommitPanelState {
    const root = targetRoot(state, repositoryRoot);
    const index = state.repositories.findIndex((repository) => repository.root === root);
    const existing =
        index >= 0
            ? state.repositories[index]
            : createRepositoryState(root, root === LEGACY_REPOSITORY_ROOT ? "" : root);
    const nextRepository = update(existing);
    const repositories =
        index >= 0
            ? state.repositories.map((repository, currentIndex) =>
                  currentIndex === index ? nextRepository : repository,
              )
            : [...state.repositories, nextRepository];
    const activeRepositoryRoot = state.activeRepositoryRoot ?? root;
    const expandedRepositoryRoots =
        state.expandedRepositoryRoots.length > 0
            ? state.expandedRepositoryRoots
            : state.repositories.length > 0
              ? []
              : [root];
    // `hydrated` carries through rather than being set here: it means the repository LIST arrived,
    // which is the thing the retry is waiting for. A per-repository update is a different message
    // and answers a different question.
    return { ...state, repositories, activeRepositoryRoot, expandedRepositoryRoots };
}

/**
 * Applies an action only to an already-hydrated repository.
 *
 * Lifecycle events must never create a row from an arbitrary host root: a stale event from a
 * removed repository is not a snapshot and therefore has no authority to add state.
 */
function updateKnownRepository(
    state: MultiRepositoryCommitPanelState,
    repositoryRoot: string,
    update: (repository: RepositoryCommitPanelState) => RepositoryCommitPanelState,
): MultiRepositoryCommitPanelState {
    const index = state.repositories.findIndex((repository) => repository.root === repositoryRoot);
    if (index < 0) return state;
    return {
        ...state,
        repositories: state.repositories.map((repository, currentIndex) =>
            currentIndex === index ? update(repository) : repository,
        ),
    };
}

function updateRepositoryMetadata(
    repository: RepositoryCommitPanelState,
    summary: CommitPanelRepositorySummary,
): RepositoryCommitPanelState {
    return {
        ...repository,
        root: summary.root,
        label: summary.label,
        kind: summary.kind,
        changedFileCount: summary.changedFileCount,
    };
}

/**
 * Applies one generation event after the reducer has validated its request identity.
 *
 * Terminal events restore the prior draft when appropriate and clear the active marker so later
 * draft messages may update the repository again.
 */
function applyGenerationEvent(
    repository: RepositoryCommitPanelState,
    action: Extract<CommitPanelAction, { type: "COMMIT_MESSAGE_GENERATION_EVENT" }>,
): RepositoryCommitPanelState {
    switch (action.kind) {
        case "start":
            return repository.generation.status === "requested"
                ? {
                      ...repository,
                      commitMessage: commitMessageGenerationPrefix(
                          repository.generation.snapshot ?? repository.commitMessage,
                      ),
                      generation: { ...repository.generation, status: "running" },
                  }
                : repository;
        case "chunk":
            return repository.generation.status === "running"
                ? { ...repository, commitMessage: repository.commitMessage + (action.text ?? "") }
                : repository;
        case "done":
            return {
                ...repository,
                ...(action.superseded
                    ? { commitMessage: repository.generation.snapshot ?? repository.commitMessage }
                    : {}),
                generation: { status: "idle" },
            };
        case "cancelled":
        case "error":
            return {
                ...repository,
                commitMessage: repository.generation.snapshot ?? repository.commitMessage,
                generation: { status: "idle" },
            };
    }
}

function reducer(
    state: MultiRepositoryCommitPanelState,
    action: CommitPanelAction,
): MultiRepositoryCommitPanelState {
    switch (action.type) {
        case "SET_REPOSITORIES": {
            const roots = new Set(action.repositories.map((repository) => repository.root));
            const activeRepositoryRoot =
                action.activeRepositoryRoot !== null && roots.has(action.activeRepositoryRoot)
                    ? action.activeRepositoryRoot
                    : (action.repositories[0]?.root ?? null);
            return {
                hydrated: true,
                repositories: action.repositories.map((summary) => {
                    const existing = state.repositories.find(
                        (repository) => repository.root === summary.root,
                    );
                    return updateRepositoryMetadata(
                        existing ??
                            createRepositoryState(summary.root, summary.label, summary.kind),
                        summary,
                    );
                }),
                activeRepositoryRoot,
                expandedRepositoryRoots: expandedRootsFor(
                    state,
                    action.repositories,
                    activeRepositoryRoot,
                ),
            };
        }
        case "SET_EXPANDED_REPOSITORIES": {
            const knownRoots = new Set(state.repositories.map((repository) => repository.root));
            return {
                ...state,
                expandedRepositoryRoots: action.repositoryRoots.filter((root) =>
                    knownRoots.has(root),
                ),
            };
        }
        case "SET_FILES_AND_STASHES":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                label: action.repositoryLabel ?? repository.label,
                changedFileCount: action.changedFileCount ?? countChangedFiles(action.files),
                files: action.files,
                filesHydrated: true,
                stashes: action.stashes,
                stashFiles: action.stashFiles,
                selectedStashIndex: action.selectedStashIndex,
                shelves: action.shelves,
                catalogGeneration: action.catalogGeneration,
                selectedShelfId: action.selectedShelfId,
                shelfRemoveOnUnshelve: action.shelfRemoveOnUnshelve,
                shelfHealth: action.shelfHealth,
                folderIcon: action.folderIcon ?? repository.folderIcon,
                folderExpandedIcon: action.folderExpandedIcon ?? repository.folderExpandedIcon,
                folderIconsByName: action.folderIconsByName ?? repository.folderIconsByName,
                iconFonts: action.iconFonts ?? repository.iconFonts,
                currentBranchHasUpstream: action.currentBranchHasUpstream,
                hasRemotes: action.hasRemotes ?? repository.hasRemotes,
                currentBranchAhead: action.currentBranchAhead,
                currentBranchBehind: action.currentBranchBehind,
                currentBranchName:
                    action.currentBranchName !== undefined
                        ? action.currentBranchName
                        : repository.currentBranchName,
                currentBranchUpstream:
                    action.currentBranchUpstream !== undefined
                        ? action.currentBranchUpstream
                        : repository.currentBranchUpstream,
                // The classification moves as a pair. An action without one is a partial update
                // and must not erase the operation the toolbar is rendering, or the rebase
                // controls vanish on the next unrelated refresh; an action with one replaces
                // both, so a finished rebase cannot strand its ownership state behind it.
                ...(action.activeOperation === undefined
                    ? {
                          activeOperation: repository.activeOperation,
                          rebaseControl: repository.rebaseControl,
                      }
                    : {
                          activeOperation: action.activeOperation,
                          rebaseControl: action.rebaseControl,
                      }),
                hasCommits: action.hasCommits ?? repository.hasCommits,
                wholeIndexOperationInProgress:
                    action.wholeIndexOperationInProgress ??
                    repository.wholeIndexOperationInProgress,
                isRefreshing: action.refreshing ?? repository.isRefreshing,
                error: action.error ?? null,
            }));
        case "SET_REFRESHING":
            return updateRepository(state, action.repositoryRoot, (repository) => {
                if (action.active && repository.isAmend) {
                    return {
                        ...repository,
                        isRefreshing: true,
                        amendBranchCommits: [],
                        amendBranchHistoryLoaded: false,
                    };
                }
                return { ...repository, isRefreshing: action.active };
            });
        case "RESTORE_COMMIT_DRAFT":
        case "SET_LAST_COMMIT_MESSAGE":
        case "SET_COMMIT_MESSAGE":
            return updateRepository(state, action.repositoryRoot, (repository) =>
                repository.generation.status === "idle"
                    ? { ...repository, commitMessage: action.message }
                    : repository,
            );
        case "COMMITTED":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                commitMessage: action.clearCommitMessage === false ? repository.commitMessage : "",
                isAmend: false,
                amendBranchCommits: [],
                amendBranchHistoryLoaded: false,
            }));
        case "SET_ERROR":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                error: action.message,
            }));
        case "SET_SHELF_MUTATION_OUTCOME":
            return updateRepository(state, action.repositoryRoot, (repository) => ({
                ...repository,
                shelfMutationOutcome: {
                    requestId: action.requestId,
                    status: action.status,
                    entries: action.entries,
                    message: action.message,
                    shelfId: action.shelfId,
                    newGeneration: action.newGeneration,
                },
            }));
        case "SET_AMEND":
            return updateRepository(state, action.repositoryRoot, (repository) => {
                if (repository.generation.status !== "idle") return repository;
                return {
                    ...repository,
                    isAmend: action.isAmend,
                    amendBranchCommits: [],
                    amendBranchHistoryLoaded: false,
                };
            });
        case "REQUEST_COMMIT_MESSAGE_GENERATION":
            return updateKnownRepository(state, action.repositoryRoot, (repository) => {
                if (repository.generation.status !== "idle") return repository;
                return {
                    ...repository,
                    generation: {
                        status: "requested",
                        requestId: action.requestId,
                        snapshot: action.snapshot,
                    },
                };
            });
        case "COMMIT_MESSAGE_GENERATION_EVENT":
            return updateKnownRepository(state, action.repositoryRoot, (repository) => {
                if (
                    repository.generation.status === "idle" ||
                    repository.generation.requestId !== action.requestId
                ) {
                    return repository;
                }
                return applyGenerationEvent(repository, action);
            });
        case "SET_AMEND_BRANCH_COMMITS":
            return updateRepository(state, action.repositoryRoot, (repository) => {
                if (!repository.isAmend) return repository;
                return {
                    ...repository,
                    amendBranchCommits: action.commits,
                    amendBranchHistoryLoaded: true,
                };
            });
    }
}

/**
 * Subscribes to extension-host commit-panel messages and exposes reducer state.
 *
 * Host snapshots are merged by repository root. Rootless messages target the
 * active repository so the docked panel remains compatible with older producers.
 */
export function useExtensionMessages(): [
    MultiRepositoryCommitPanelState,
    Dispatch<CommitPanelAction>,
] {
    const [state, reactDispatch] = useReducer(reducer, initialState);
    const stateRef = useRef(initialState);

    /**
     * Reduces an action into a synchronous mirror before React schedules its render.
     *
     * VS Code may synchronously answer an outbound request, so the message handler must be able to
     * validate the just-created request ID without waiting for a component render.
     */
    const applyAction = useCallback(
        (action: CommitPanelAction): MultiRepositoryCommitPanelState => {
            const nextState = reducer(stateRef.current, action);
            stateRef.current = nextState;
            reactDispatch(action);
            return nextState;
        },
        [reactDispatch],
    );
    const dispatch = useCallback(
        (action: CommitPanelAction): void => {
            applyAction(action);
        },
        [applyAction],
    );

    useEffect(() => {
        const vscode = getVsCodeApi();

        const handler = (event: MessageEvent<InboundMessage>) => {
            const msg = event.data;
            switch (msg.type) {
                case "setRepositories":
                    applyAction({
                        type: "SET_REPOSITORIES",
                        repositories: msg.repositories,
                        activeRepositoryRoot: msg.activeRepositoryRoot,
                    });
                    break;
                case "update":
                    applyAction({
                        type: "SET_FILES_AND_STASHES",
                        repositoryRoot: msg.repositoryRoot,
                        repositoryLabel: msg.repositoryLabel,
                        changedFileCount: msg.changedFileCount,
                        files: msg.files,
                        stashes: msg.stashes,
                        stashFiles: msg.stashFiles,
                        selectedStashIndex: msg.selectedStashIndex,
                        shelves: msg.shelves ?? [],
                        catalogGeneration: msg.catalogGeneration ?? 0,
                        selectedShelfId: msg.selectedShelfId ?? null,
                        shelfRemoveOnUnshelve: msg.shelfRemoveOnUnshelve ?? true,
                        shelfHealth: msg.shelfHealth ?? [],
                        folderIcon: msg.folderIcon,
                        folderExpandedIcon: msg.folderExpandedIcon,
                        folderIconsByName: msg.folderIconsByName,
                        iconFonts: msg.iconFonts,
                        currentBranchHasUpstream: msg.currentBranchHasUpstream ?? true,
                        hasRemotes: msg.hasRemotes,
                        currentBranchAhead: msg.currentBranchAhead ?? 0,
                        currentBranchBehind: msg.currentBranchBehind ?? 0,
                        currentBranchName: msg.currentBranchName,
                        currentBranchUpstream: msg.currentBranchUpstream,
                        activeOperation: msg.activeOperation,
                        rebaseControl: msg.rebaseControl,
                        hasCommits: msg.hasCommits,
                        wholeIndexOperationInProgress: msg.wholeIndexOperationInProgress,
                        refreshing: msg.refreshing,
                        error: msg.error,
                    });
                    break;
                case "restoreCommitDraft":
                    applyAction({
                        type: "RESTORE_COMMIT_DRAFT",
                        repositoryRoot: msg.repositoryRoot,
                        message: msg.message,
                    });
                    break;
                case "lastCommitMessage":
                    applyAction({
                        type: "SET_LAST_COMMIT_MESSAGE",
                        repositoryRoot: msg.repositoryRoot,
                        message: msg.message,
                    });
                    break;
                case "amendBranchCommits":
                    applyAction({
                        type: "SET_AMEND_BRANCH_COMMITS",
                        repositoryRoot: msg.repositoryRoot,
                        commits: msg.commits,
                    });
                    break;
                case "committed":
                    applyAction({
                        type: "COMMITTED",
                        repositoryRoot: msg.repositoryRoot,
                        clearCommitMessage: msg.clearCommitMessage,
                    });
                    break;
                case "refreshing":
                    applyAction({
                        type: "SET_REFRESHING",
                        repositoryRoot: msg.repositoryRoot,
                        active: msg.active,
                    });
                    break;
                case "error":
                    applyAction({
                        type: "SET_ERROR",
                        repositoryRoot: msg.repositoryRoot,
                        message: msg.message,
                    });
                    break;
                case "shelfMutationCompleted":
                    applyAction({
                        type: "SET_SHELF_MUTATION_OUTCOME",
                        repositoryRoot: msg.repositoryRoot,
                        status: msg.status,
                        entries: msg.entries,
                        requestId: msg.requestId,
                        message: msg.message,
                        shelfId: msg.shelfId,
                        newGeneration: msg.newGeneration,
                    });
                    break;
                case "commitMessageGeneration": {
                    const repository = stateRef.current.repositories.find(
                        (candidate) => candidate.root === msg.repositoryRoot,
                    );
                    if (
                        !repository ||
                        repository.generation.status === "idle" ||
                        repository.generation.requestId !== msg.requestId
                    ) {
                        break;
                    }
                    const nextState = applyAction({
                        type: "COMMIT_MESSAGE_GENERATION_EVENT",
                        repositoryRoot: msg.repositoryRoot,
                        requestId: msg.requestId,
                        kind: msg.kind,
                        text: msg.text,
                        superseded: msg.superseded,
                    });
                    if (msg.kind === "done" || msg.kind === "cancelled" || msg.kind === "error") {
                        const nextRepository = nextState.repositories.find(
                            (candidate) => candidate.root === msg.repositoryRoot,
                        );
                        if (!msg.superseded && nextRepository) {
                            vscode.postMessage({
                                type: "saveCommitDraft",
                                repositoryRoot: msg.repositoryRoot,
                                message: nextRepository.commitMessage,
                            });
                        }
                    }
                    break;
                }
            }
        };

        window.addEventListener("message", handler);
        let attempt = 1;
        let elapsed = 0;
        vscode.postMessage({ type: "ready", attempt });

        // Re-asking is safe to repeat: the host's `ready` handler posts the repository list and its
        // cached working-tree state, both idempotent, and it costs nothing on a healthy startup
        // because the answer lands long before the first tick.
        // `state.hydrated` rather than a flag private to this effect: the retry and the render must
        // agree on what "answered" means, and the host answers unconditionally, so an empty
        // repository list is an answer and stops the retry.
        // A self-rescheduling timeout rather than an interval, because the cadence changes once the
        // opening burst is spent -- and it never schedules past an answer, so a hydrated panel goes
        // quiet on its own without needing a second timer to cancel the first.
        let retry: ReturnType<typeof setTimeout> | undefined;
        const askAgain = (): void => {
            if (stateRef.current.hydrated) return;
            attempt += 1;
            vscode.postMessage({ type: "ready", attempt });
            scheduleRetry();
        };
        function scheduleRetry(): void {
            const delay =
                elapsed < HYDRATION_BURST_MS ? HYDRATION_RETRY_INTERVAL_MS : HYDRATION_HEARTBEAT_MS;
            elapsed += delay;
            retry = setTimeout(askAgain, delay);
        }
        scheduleRetry();

        return () => {
            window.removeEventListener("message", handler);
            if (retry !== undefined) clearTimeout(retry);
        };
    }, [applyAction]);

    return [state, dispatch];
}
