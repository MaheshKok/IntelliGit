import { useChangelistDraft } from "./useChangelistDraft";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangelistState } from "../../../protocol/changeSelection";
import type { ChangelistOutbound, ChangelistReply } from "../../../protocol/changelists";
import type { WorkingFile } from "../../../../types";
import { getVsCodeApi } from "../../shared/vscodeApi";
import type { CommitTabProps } from "../components/CommitTabController";

interface ClientState {
    root?: string;
    metadata?: ChangelistState;
    filter: string;
    checked: Record<string, string[]>;
    busy: boolean;
    hasRecoveryIssues?: boolean;
    error?: string;
    notice?: string;
}

/** Restores bounded per-worktree filters and checkbox choices; callers reconcile saved paths against current files. */
function savedView(value: Record<string, unknown> | undefined, root: string) {
    const views = value?.changelistViews;
    if (!views || typeof views !== "object") return { filter: "all", checked: {} };
    const view = (views as Record<string, unknown>)[root] as
        { filter?: unknown; checked?: unknown } | undefined;
    const checked: Record<string, string[]> = {};
    if (view?.checked && typeof view.checked === "object" && !Array.isArray(view.checked)) {
        for (const [id, paths] of Object.entries(view.checked)) {
            if (id.length <= 64 && Array.isArray(paths) && paths.length <= 20_000) {
                checked[id] = paths.filter(
                    (file): file is string => typeof file === "string" && file.length <= 4096,
                );
            }
        }
    }
    return { filter: typeof view?.filter === "string" ? view.filter : "all", checked };
}

/** Deleted scope redirects affect presentation only; commits still require an existing exact ID. */
function resolveViewScope(state: ChangelistState, scope: string): string {
    if (scope === "all" || state.lists.some((list) => list.id === scope)) return scope;
    return state.removedScopes?.[scope] ?? "all";
}

/** A file can appear in multiple lists when its different lines have different owners. */
export function changelistFiles(
    files: WorkingFile[],
    state: ChangelistState,
    id: string,
): WorkingFile[] {
    if (id === "all") return files;
    return files.filter((file) => {
        const assigned = Object.hasOwn(state.files, file.path)
            ? state.files[file.path]
            : state.activeId;
        const ownership = state.changes[file.path];
        const known = ownership?.totalChanges;
        return (
            (assigned === id &&
                (ownership?.stale ||
                    known === undefined ||
                    known === 0 ||
                    Object.keys(ownership?.lines ?? {}).length < known)) ||
            Object.values(ownership?.lines ?? {}).includes(id)
        );
    });
}

/** One list and no line selections is plain Git use, so the panel keeps its pre-changelist layout. */
export function changelistsInUse(state: ChangelistState, hasRecoveryIssues: boolean): boolean {
    return (
        state.lists.length > 1 ||
        hasRecoveryIssues ||
        state.targetOperationSummary?.phase === "reviewRequired" ||
        Object.values(state.changes).some(
            (ownership) => Object.keys(ownership?.selections ?? {}).length > 0,
        )
    );
}

/** Keeps list filters and checkboxes repository-scoped without launching Git on UI selections. */
export function useChangelists(props: CommitTabProps) {
    const root = props.repositoryRoot;
    const api = getVsCodeApi<ChangelistOutbound, Record<string, unknown>>();
    const [state, setState] = useState<ClientState>({ filter: "all", checked: {}, busy: false });
    const pendingSave = useRef<{ root: string; requestId: string } | undefined>(undefined);
    // The control that sent a host request; it is disabled while busy and so loses focus.
    const opener = useRef<HTMLElement | null>(null);
    const remember = () => {
        opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
    };
    const busy = state.root === root && state.busy;
    useEffect(() => {
        if (busy) return;
        // Waits for the host to give the webview focus back, so a still-open native prompt keeps
        // it; then reclaims only focus the busy state took away, never focus the user moved.
        const restore = () => {
            const element = opener.current;
            if (!element || !document.hasFocus()) return;
            opener.current = null;
            if (element.isConnected && document.activeElement === document.body) element.focus();
        };
        restore();
        window.addEventListener("focus", restore);
        return () => window.removeEventListener("focus", restore);
    }, [busy]);
    const metadata = state.root === root ? state.metadata : undefined;
    const filter = state.root === root ? state.filter : "all";
    useEffect(() => {
        if (!root) return;
        pendingSave.current = undefined;
        let received = false;
        const receive = (
            event: MessageEvent<
                ChangelistReply | { type: "error"; repositoryRoot?: string; message: string }
            >,
        ) => {
            const message = event.data;
            if (!message || message.repositoryRoot !== root) return;
            if (message.type === "setChangelists") {
                if (
                    !message.state ||
                    !Number.isSafeInteger(message.state.revision) ||
                    !Array.isArray(message.state.lists)
                )
                    return;
                received = true;
                const saved = savedView(api.getState(), root);
                setState((previous) =>
                    previous.root === root &&
                    previous.metadata &&
                    previous.metadata.revision > message.state.revision
                        ? previous
                        : {
                              root,
                              metadata:
                                  previous.root === root &&
                                  previous.metadata?.revision === message.state.revision
                                      ? previous.metadata
                                      : message.state,
                              // A view saved while several lists existed must not scope plain mode, even for one render.
                              filter: changelistsInUse(
                                  message.state,
                                  message.hasRecoveryIssues === true,
                              )
                                  ? resolveViewScope(
                                        message.state,
                                        previous.root === root ? previous.filter : saved.filter,
                                    )
                                  : "all",
                              checked: previous.root === root ? previous.checked : saved.checked,
                              busy: message.busy === true || pendingSave.current?.root === root,
                              hasRecoveryIssues: message.hasRecoveryIssues === true,
                              error: previous.root === root ? previous.error : undefined,
                              notice: previous.root === root ? previous.notice : undefined,
                          },
                );
            } else if (message.type === "changelistShelfResult") {
                if (pendingSave.current?.requestId !== message.requestId) return;
                pendingSave.current = undefined;
                setState((previous) => ({
                    ...previous,
                    root,
                    busy: false,
                    error: message.error,
                    notice: message.error ? undefined : message.message,
                }));
            } else if (message.type === "error") {
                received = true;
                // A save that failed before its handler ran gets only this reply, so stop waiting for its result.
                pendingSave.current = undefined;
                setState((previous) => ({
                    ...previous,
                    root,
                    busy: false,
                    error: message.message,
                }));
            }
        };
        window.addEventListener("message", receive);
        const ask = () => {
            if (!received) api.postMessage({ type: "loadChangelists", repositoryRoot: root });
        };
        ask();
        const timer = window.setInterval(ask, 1000);
        return () => {
            window.removeEventListener("message", receive);
            window.clearInterval(timer);
        };
    }, [api, root]);
    const files = useMemo(
        () => (metadata ? changelistFiles(props.files, metadata, filter) : props.files),
        [filter, metadata, props.files],
    );
    const validPaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
    const checkedPaths = useMemo(
        () =>
            filter === "all"
                ? props.checkedPaths
                : new Set((state.checked[filter] ?? []).filter((file) => validPaths.has(file))),
        [validPaths, filter, props.checkedPaths, state.checked],
    );
    const partialPaths = useMemo(
        () =>
            new Set(
                files
                    .filter((file) => {
                        const ownership = metadata?.changes[file.path];
                        return (
                            ownership?.selections?.[filter] !== undefined ||
                            Object.keys(ownership?.lines ?? {}).length > 0
                        );
                    })
                    .map((file) => file.path),
            ),
        [files, filter, metadata],
    );
    const draft = useChangelistDraft(props, metadata, filter, checkedPaths);
    const hasEligibleSelection = [...checkedPaths].some((file) => {
        const selection = metadata?.changes[file]?.selections?.[filter];
        return (
            selection === undefined || (!selection.reviewRequired && selection.lineIds.length > 0)
        );
    });
    useEffect(() => {
        if (!root || !metadata) return;
        const saved = api.getState() ?? {};
        const views = saved.changelistViews;
        api.setState({
            ...saved,
            changelistViews: {
                ...(views && typeof views === "object" ? views : {}),
                [root]: { filter, checked: state.checked },
            },
        });
    }, [api, filter, metadata, root, state.checked]);
    const choose = useCallback(
        (value: string) => {
            draft.cancel();
            if (value !== "all" && props.isAmend) props.onAmendChange(false);
            setState((previous) => ({ ...previous, root, filter: value, error: undefined }));
        },
        [root, draft, props],
    );
    const toggle = useCallback(
        (changed: WorkingFile[]) => {
            if (filter === "all") return props.onToggleSection(changed);
            const paths = [
                ...new Set(changed.filter((file) => file.status !== "!").map((file) => file.path)),
            ];
            setState((previous) => {
                const selected = new Set(previous.checked[filter] ?? []);
                const remove = paths.every((file) => selected.has(file));
                for (const file of paths) {
                    if (remove) selected.delete(file);
                    else selected.add(file);
                }
                return { ...previous, checked: { ...previous.checked, [filter]: [...selected] } };
            });
        },
        [filter, props],
    );
    const command = useCallback(
        (
            action:
                | "create"
                | "rename"
                | "remove"
                | "activate"
                | "move"
                | "resetSelection"
                | "reviewRecovery",
            listId = filter,
        ) => {
            if (!root || !metadata) return;
            remember();
            setState((previous) => ({ ...previous, busy: true, error: undefined }));
            api.postMessage({
                type: "changelistAction",
                repositoryRoot: root,
                revision: metadata.revision,
                action,
                ...(action === "move" ? { sourceListId: filter } : {}),
                ...(action !== "create" && action !== "move" ? { listId } : {}),
                ...(action === "move" || action === "resetSelection"
                    ? {
                          // Reset sends only what showed a selection, so one added since stays.
                          paths: [...checkedPaths].filter(
                              (file) =>
                                  action === "move" ||
                                  metadata.changes[file]?.selections?.[filter] !== undefined,
                          ),
                      }
                    : {}),
            });
        },
        [api, checkedPaths, filter, metadata, root],
    );
    const openPartial = useCallback(() => {
        if (!root || checkedPaths.size !== 1) return;
        api.postMessage({
            type: "openPartialChanges",
            repositoryRoot: root,
            path: [...checkedPaths][0],
            ...(filter !== "all" ? { listId: filter } : {}),
        });
    }, [api, checkedPaths, filter, root]);
    const saveShelf = useCallback(
        (
            scope: "list" | "files",
            listId = filter,
            operation: "save" | "saveAndRemove" | "rollback" = "save",
        ) => {
            if (
                !root ||
                !metadata ||
                pendingSave.current ||
                (scope === "files" && checkedPaths.size === 0)
            )
                return;
            const requestId = crypto.randomUUID();
            pendingSave.current = { root, requestId };
            remember();
            setState((previous) => ({
                ...previous,
                busy: true,
                error: undefined,
                notice: undefined,
            }));
            api.postMessage({
                type: "saveChangelistShelf",
                repositoryRoot: root,
                requestId,
                revision: metadata.revision,
                scope,
                listId,
                ...(scope === "files" ? { paths: [...checkedPaths] } : {}),
                ...(operation !== "save" ? { operation } : {}),
            });
        },
        [api, checkedPaths, filter, metadata, root],
    );
    const commit = useCallback(
        (push = false) => {
            if (!root || !metadata) {
                if (push) props.onPush();
                else props.onCommit();
                return;
            }
            if (props.wholeIndexOperationInProgress || draft.pending || draft.error) return;
            if (push && checkedPaths.size === 0 && !props.isAmend) return props.onPush();
            setState((previous) => ({ ...previous, busy: true, error: undefined }));
            api.postMessage({
                type: "commitChangelist",
                repositoryRoot: root,
                revision: metadata.revision,
                listId: filter,
                paths: [...checkedPaths],
                message: draft.message.trim(),
                amend: props.isAmend,
                push,
            });
        },
        [api, checkedPaths, draft, filter, metadata, props, root],
    );
    return {
        draft,
        metadata,
        filter,
        files,
        checkedPaths,
        partialPaths,
        hasEligibleSelection,
        choose,
        command,
        saveShelf,
        notice: state.root === root ? state.notice : undefined,
        openPartial,
        commit,
        busy,
        hasRecoveryIssues: state.root === root && state.hasRecoveryIssues === true,
        error: state.root === root ? state.error : undefined,
        toggleFile:
            filter === "all"
                ? props.onToggleFile
                : (file: string) => toggle(files.filter((entry) => entry.path === file)),
        toggleFolder: filter === "all" ? props.onToggleFolder : toggle,
        toggleSection: filter === "all" ? props.onToggleSection : toggle,
        allChecked: (values: WorkingFile[]) =>
            values
                .filter((file) => file.status !== "!")
                .every((file) => checkedPaths.has(file.path)),
        someChecked: (values: WorkingFile[]) => values.some((file) => checkedPaths.has(file.path)),
    };
}
