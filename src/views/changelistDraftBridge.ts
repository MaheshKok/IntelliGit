import { ChangelistStore } from "../changes/changelistStore";
import type { NativeCommitInputBridgeOptions } from "./nativeCommitInputBridge";
import type * as vscode from "vscode";

/** Attach native inputs only after durable drafts are loaded; failures preserve the native buffer. */
export function attachAfterChangelistLoad(
    storage: vscode.Memento | undefined,
    root: string,
    directories: () => Promise<{ gitDir: string }>,
    attach: () => void,
): void {
    const store = ChangelistStore.forStorage(storage);
    if (!store.needsConnection(root)) {
        attach();
        return;
    }
    void directories()
        .then(({ gitDir }) => store.connect(root, gitDir))
        .then(attach)
        .catch((error: unknown) => {
            console.error("[IntelliGit] Native changelist drafts require review:", error);
        });
}

/** Native SCM mirrors the last focused scope, shared by docked and undocked providers. */
export function changelistDraftBridge(
    storage: vscode.Memento | undefined,
    onNativeChange: (root: string, text: string) => void,
): NativeCommitInputBridgeOptions {
    const store = ChangelistStore.forStorage(storage);
    const pending = new Map<string, { text: string }>();
    return {
        readDraft: (root) => {
            try {
                return store.draft(root, store.mirrorScope(root));
            } catch {
                return readLegacyDraft(storage, `commitDraft:${root}`);
            }
        },
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

/**
 * Reads All without adopting a named scope. Refused metadata leaves the composer readable
 * from the bounded legacy draft; writes still go through the store's refusal checks.
 */
export function readAggregateDraft(
    storage: vscode.Memento | undefined,
    storageKey: string,
): string {
    try {
        return ChangelistStore.forStorage(storage).draft(
            storageKey.slice("commitDraft:".length),
            "all",
        );
    } catch {
        return readLegacyDraft(storage, storageKey);
    }
}

/** Restores only bounded text; invalid legacy values never reach native or webview inputs. */
function readLegacyDraft(storage: vscode.Memento | undefined, storageKey: string): string {
    const legacy = storage?.get<unknown>(storageKey);
    return typeof legacy === "string" && legacy.length <= 100_000 ? legacy : "";
}
