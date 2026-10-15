import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ChangelistState } from "../../../protocol/changeSelection";
import type { ChangelistOutbound, ChangelistReply } from "../../../protocol/changelists";
import type {
    OutboundMessage as CommitPanelOutbound,
    InboundMessage,
} from "../../../protocol/commitPanelMessages";

import type { CommitTabProps } from "../components/CommitTabController";
import { getVsCodeApi } from "../../shared/vscodeApi";
import { commitMessageGenerationPrefix } from "../../shared/commitMessageDraft";

interface DraftBuffer {
    text: string;
    base: string;
    pending: Set<string>;
    error?: string;
}
interface Generation {
    root: string;
    scope: string;
    requestId: string;
    snapshot: string;
    text: string;
    status: "requested" | "running";
}
let sequence = 0;

/** Keep optimistic edits until acknowledged; switching scope cannot redirect queued writes or AI replies. */
export function useChangelistDraft(
    props: CommitTabProps,
    state: ChangelistState | undefined,
    scope: string,
    paths: ReadonlySet<string>,
) {
    const api = getVsCodeApi<ChangelistOutbound | CommitPanelOutbound, Record<string, unknown>>();
    const buffers = useRef(new Map<string, DraftBuffer>());
    const generation = useRef<Generation>();
    const [, render] = useReducer((value: number) => value + 1, 0);
    const root = props.repositoryRoot;
    const key = JSON.stringify([root, scope]);
    const serverText =
        scope === "all"
            ? (state?.allDraft ?? "")
            : (state?.lists.find((list) => list.id === scope)?.draft ?? "");
    let buffer = buffers.current.get(key);
    if (!buffer) {
        buffer = { text: serverText, base: serverText, pending: new Set() };
        buffers.current.set(key, buffer);
    }
    if (!buffer.pending.size && !buffer.error && buffer.base !== serverText) {
        buffer.text = serverText;
        buffer.base = serverText;
    }

    const save = useCallback(
        (capturedRoot: string, capturedScope: string, text: string) => {
            const capturedKey = JSON.stringify([capturedRoot, capturedScope]);
            const current = buffers.current.get(capturedKey);
            if (!current) return;
            const expected = current.error ? current.base : current.text;
            const requestId = `changelist-draft-${++sequence}`;
            current.text = text;
            current.error = undefined;
            current.pending.add(requestId);
            api.postMessage({
                type: "changelistDraft",
                action: "save",
                repositoryRoot: capturedRoot,
                listId: capturedScope,
                expected,
                message: text,
                requestId,
            });
            render();
        },
        [api],
    );

    const cancel = useCallback(() => {
        const current = generation.current;
        if (!current) return;
        generation.current = undefined;
        api.postMessage({
            type: "cancelCommitMessageGeneration",
            repositoryRoot: current.root,
            requestId: current.requestId,
        });
        render();
    }, [api]);

    const ready = state !== undefined;
    useEffect(() => {
        if (!root || !ready) return;
        cancel();
        api.postMessage({
            type: "changelistDraft",
            action: "select",
            repositoryRoot: root,
            listId: scope,
        });
        return cancel;
    }, [api, cancel, root, scope, ready]);

    useEffect(() => {
        const receive = (
            event: MessageEvent<
                ChangelistReply | Extract<InboundMessage, { type: "commitMessageGeneration" }>
            >,
        ) => {
            const message = event.data;
            if (message.type === "changelistDraftResult") {
                const current = buffers.current.get(
                    JSON.stringify([message.repositoryRoot, message.listId]),
                );
                if (!current?.pending.has(message.requestId)) return;
                current.pending.delete(message.requestId);
                current.base = message.message;
                if (message.error) current.error = message.error;
                render();
            } else if (message.type === "commitMessageGeneration") {
                const current = generation.current;
                if (
                    !current ||
                    current.root !== message.repositoryRoot ||
                    current.requestId !== message.requestId
                )
                    return;
                if (message.kind === "start") {
                    current.status = "running";
                    current.text = commitMessageGenerationPrefix(current.snapshot);
                } else if (message.kind === "chunk") current.text += message.text ?? "";
                else {
                    generation.current = undefined;
                    const captured = buffers.current.get(
                        JSON.stringify([current.root, current.scope]),
                    );
                    if (
                        message.kind === "done" &&
                        !message.superseded &&
                        captured?.text === current.snapshot
                    )
                        save(current.root, current.scope, current.text);
                }
                render();
            }
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, [save]);

    const currentGeneration = generation.current;
    const streaming =
        currentGeneration && currentGeneration.root === root && currentGeneration.scope === scope
            ? currentGeneration
            : undefined;
    return {
        message: state ? (streaming?.text ?? buffer.text) : props.commitMessage,
        pending: buffer.pending.size > 0,
        error: buffer.error,
        generationStatus: streaming?.status ?? ("idle" as const),
        change: (text: string) => {
            if (!state) return props.onMessageChange(text);
            if (root && !generation.current) save(root, scope, text);
        },
        focus: () => {
            if (root && state)
                api.postMessage({
                    type: "changelistDraft",
                    action: "select",
                    repositoryRoot: root,
                    listId: scope,
                });
        },
        generate: () => {
            const canAmend = props.isAmend && scope === "all" && props.hasCommits !== false;
            if (
                !root ||
                !state ||
                generation.current ||
                buffer.pending.size ||
                buffer.error ||
                (props.isAmend && !canAmend) ||
                (!paths.size && !canAmend)
            )
                return;
            const requestId = `changelist-generation-${++sequence}`;
            generation.current = {
                root,
                scope,
                requestId,
                snapshot: buffer.text,
                text: buffer.text,
                status: "requested",
            };
            api.postMessage({
                type: "generateCommitMessage",
                repositoryRoot: root,
                requestId,
                paths: [...paths],
                amend: props.isAmend,
            });
            render();
        },
        cancel,
        amend: (value: boolean) => {
            if (scope !== "all" || !root) return;
            props.onAmendChange(value);
        },
    };
}
