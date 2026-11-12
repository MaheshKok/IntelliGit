// Read-only editor documents for CI logs: `intelligit-ci-log:/<job name>.log?k=<64-hex key>`.
// The text comes only from the window's in-memory log store; the URI carries nothing but the key.

import * as vscode from "vscode";
import type { CiLogMemoryStore } from "./ciLogMemoryStore";

/** URI scheme of CI log documents. */
export const CI_LOG_SCHEME = "intelligit-ci-log";

/** The only key shape the provider accepts: a SHA-256 in lower-case hex. */
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Serves CI log text from the store and refreshes tabs that showed a placeholder. */
class CiLogDocumentProvider implements vscode.TextDocumentContentProvider {
    // Open tabs answered with a placeholder or an error line, per key, to refresh once the log
    // loads; a tab leaves when its document closes.
    private readonly stale = new Map<string, Map<string, vscode.Uri>>();
    private readonly changeListeners = new Set<(uri: vscode.Uri) => void>();
    private readonly storeSubscription: { dispose(): void };
    private readonly closeSubscription: vscode.Disposable;

    /**
     * Starts listening to the store for loads that can replace a placeholder, and to closed tabs.
     *
     * @param store - The window's log store.
     */
    constructor(private readonly store: CiLogMemoryStore) {
        this.storeSubscription = store.onDidLoad((key) => this.refresh(key));
        this.closeSubscription = vscode.workspace.onDidCloseTextDocument((document) =>
            this.forget(document.uri),
        );
    }

    /**
     * Fires for a tab whose placeholder or error line can now be replaced by the log.
     *
     * @param listener - Receives the tab's URI.
     */
    readonly onDidChange: vscode.Event<vscode.Uri> = (listener) => {
        this.changeListeners.add(listener);
        return { dispose: () => this.changeListeners.delete(listener) };
    };

    /**
     * The log text for `uri`; a line explaining why when it is not available.
     *
     * @param uri - A CI log document URI.
     */
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const key = new URLSearchParams(uri.query).get("k");
        if (key === null || !KEY_PATTERN.test(key)) {
            return vscode.l10n.t("[IntelliGit: this CI log link is not valid.]");
        }
        const stored = this.store.get(key);
        if (stored) return stored.text;
        const source = this.store.sourceOf(key);
        if (!source) {
            this.markStale(key, uri);
            return vscode.l10n.t(
                "[IntelliGit: this CI log is no longer loaded. Open it again from the Checks tab.]",
            );
        }
        try {
            return (await this.store.load(key, source)).text;
        } catch (error) {
            // A newer load of this key may have finished while this read waited (after a clear()
            // aborted its download); that load's refresh has already fired, so serve its text.
            const current = this.store.get(key);
            if (current) return current.text;
            this.markStale(key, uri);
            const reason = error instanceof Error ? error.message : String(error);
            return vscode.l10n.t("[IntelliGit: could not load this CI log: {0}]", reason);
        }
    }

    /** Stops listening to the store and to closed tabs. */
    dispose(): void {
        this.storeSubscription.dispose();
        this.closeSubscription.dispose();
        this.changeListeners.clear();
        this.stale.clear();
    }

    private forget(uri: vscode.Uri): void {
        if (uri.scheme !== CI_LOG_SCHEME) return;
        const key = new URLSearchParams(uri.query).get("k");
        if (key === null) return;
        const uris = this.stale.get(key);
        if (!uris) return;
        uris.delete(uri.toString());
        if (uris.size === 0) this.stale.delete(key);
    }

    private markStale(key: string, uri: vscode.Uri): void {
        const uris = this.stale.get(key) ?? new Map<string, vscode.Uri>();
        uris.set(uri.toString(), uri);
        this.stale.set(key, uris);
    }

    private refresh(key: string): void {
        const uris = this.stale.get(key);
        if (!uris) return;
        this.stale.delete(key);
        for (const uri of uris.values()) {
            for (const listener of [...this.changeListeners]) listener(uri);
        }
    }
}

/**
 * Registers the `intelligit-ci-log:` document provider over the window's log store.
 *
 * @param store - The window's log store.
 * @returns Unregisters the provider and stops it listening to the store.
 */
export function registerCiLogDocumentProvider(store: CiLogMemoryStore): vscode.Disposable {
    const provider = new CiLogDocumentProvider(store);
    const registration = vscode.workspace.registerTextDocumentContentProvider(
        CI_LOG_SCHEME,
        provider,
    );
    return {
        dispose: () => {
            registration.dispose();
            provider.dispose();
        },
    };
}
