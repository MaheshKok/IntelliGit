import { ChangelistStore } from "../changes/changelistStore";
import type { NativeCommitInputBridgeOptions } from "./nativeCommitInputBridge";
import type * as vscode from "vscode";

/** Native SCM mirrors the last focused scope, shared by docked and undocked providers. */
export function changelistDraftBridge(
    storage: vscode.Memento | undefined,
    onNativeChange: (root: string, text: string) => void,
): NativeCommitInputBridgeOptions {
    const store = ChangelistStore.forStorage(storage);
    const pending = new Map<string, { text: string }>();
    return {
        readDraft: (root) => store.draft(root, store.mirrorScope(root)),
        persistDraft: (root, text) => {
            // Capture before enqueueing: a later focus/root change cannot redirect this native edit.
            const scope = store.mirrorScope(root);
            const key = JSON.stringify([root, scope]);
            const expected = pending.get(key)?.text ?? store.draft(root, scope);
            const edit = { text };
            pending.set(key, edit);
            void store
                .saveDraft(root, scope, expected, text)
                .then(() => {
                    if (scope === "all" && store.mirrorScope(root) === scope)
                        onNativeChange(root, text);
                })
                .catch((error: unknown) => {
                    console.error("[IntelliGit] Failed to persist native changelist draft:", error);
                })
                .finally(() => {
                    if (pending.get(key) === edit) pending.delete(key);
                });
        },
        onNativeChange: (root, text) => {
            if (
                !pending.has(JSON.stringify([root, store.mirrorScope(root)])) &&
                store.mirrorScope(root) === "all"
            )
                onNativeChange(root, text);
        },
    };
}

/** Compatibility composer events have no list identity and therefore address All only. */
export function saveAggregateDraft(
    storage: vscode.Memento | undefined,
    storageKey: string,
    text: string,
): Promise<unknown> {
    if (!storageKey.startsWith("commitDraft:"))
        throw new Error("Unknown commit draft storage key.");
    const root = storageKey.slice("commitDraft:".length);
    return ChangelistStore.forStorage(storage).saveDraft(root, "all", undefined, text);
}

/** Reads migrated All text without adopting the last-focused named scope. */
export function readAggregateDraft(
    storage: vscode.Memento | undefined,
    storageKey: string,
): string {
    return ChangelistStore.forStorage(storage).draft(
        storageKey.slice("commitDraft:".length),
        "all",
    );
}
