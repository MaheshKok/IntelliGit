import * as path from "path";
import * as vscode from "vscode";

/** Minimal activated API exported by VS Code's built-in Git extension. */
export interface VsCodeGitExtension {
    /** Whether the Git extension model is available for API calls. */
    enabled: boolean;
    /** Return Git API version 1. */
    getAPI(version: 1): VsCodeGitApi;
}

/** Repository collection and lifecycle events consumed by the bridge and refresh service. */
export interface VsCodeGitApi {
    repositories: VsCodeGitRepository[];
    onDidOpenRepository?: (
        listener: (repository: VsCodeGitRepository) => unknown,
    ) => vscode.Disposable;
    onDidCloseRepository?: (
        listener: (repository: VsCodeGitRepository) => unknown,
    ) => vscode.Disposable;
}

/** Git repository handle exposing the native Source Control input box. */
export interface VsCodeGitRepository {
    rootUri: vscode.Uri;
    inputBox: { value: string };
    onDidChangeState?: (listener: () => unknown) => vscode.Disposable;
}

/** Shared reconciliation state for one normalized repository root. */
export interface SharedNativeCommitInputRecord {
    base?: string;
    pending: boolean;
}

/** Process-wide records; tests can inject an isolated map through the constructor. */
const sharedRecords = new Map<string, SharedNativeCommitInputRecord>();

/**
 * Normalize repository roots for identity comparisons.
 *
 * VS Code Git roots and IntelliGit roots can differ in resolution, separator, or case on Windows.
 */
export function normalizedPath(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Construction callbacks and timer configuration for one bridge. */
export interface NativeCommitInputBridgeOptions {
    resolveApi?: () => Promise<VsCodeGitApi | undefined>;
    readDraft: (root: string) => string;
    persistDraft: (root: string, text: string) => void;
    onNativeChange: (root: string, text: string) => void;
    pollIntervalMs?: number;
    shared?: Map<string, SharedNativeCommitInputRecord>;
}

/**
 * Mirrors VS Code's native commit input box to one IntelliGit composer.
 *
 * All public operations are synchronous. API discovery is the only asynchronous work and starts
 * during construction; a late result is ignored after disposal.
 */
export class NativeCommitInputBridge {
    private api: VsCodeGitApi | undefined;
    private interval: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private readonly attachedRoots = new Set<string>();
    private readonly displayRoots = new Map<string, string>();
    private readonly seen = new Map<string, string | undefined>();
    private readonly loggedRootErrors = new Set<string>();
    private readonly shared: Map<string, SharedNativeCommitInputRecord>;
    private readonly readDraft: (root: string) => string;
    private readonly persistDraft: (root: string, text: string) => void;
    private readonly onNativeChange: (root: string, text: string) => void;
    private readonly pollIntervalMs: number;

    /** Create a bridge and start resolving the Git API. */
    public constructor(options: NativeCommitInputBridgeOptions) {
        this.shared = options.shared ?? sharedRecords;
        this.readDraft = options.readDraft;
        this.persistDraft = options.persistDraft;
        this.onNativeChange = options.onNativeChange;
        this.pollIntervalMs = options.pollIntervalMs ?? 1000;

        const resolveApi = options.resolveApi ?? defaultResolveApi;
        try {
            void resolveApi()
                .then((api) => {
                    if (!this.disposed) this.api = api;
                })
                .catch((error: unknown) => {
                    this.logResolveError(error);
                });
        } catch (error: unknown) {
            this.logResolveError(error);
        }
    }

    /** Attach one repository root; repeated attachment is harmless. */
    public attach(root: string): void {
        if (this.disposed) return;
        const key = normalizedPath(root);
        if (this.attachedRoots.has(key)) return;
        this.attachedRoots.add(key);
        this.displayRoots.set(key, root);
    }

    /** Detach one root and forget only this bridge's delivery memo. */
    public detach(root: string): void {
        const key = normalizedPath(root);
        this.attachedRoots.delete(key);
        this.displayRoots.delete(key);
        this.seen.delete(key);
    }

    /** Reconcile and deliver all currently attached roots once. */
    public tick(): void {
        if (this.disposed || !this.api) return;

        for (const root of this.attachedRoots) {
            try {
                this.tickRoot(root);
            } catch (error: unknown) {
                this.logRootError(root, error);
            }
        }
    }

    private tickRoot(root: string): void {
        const repository = this.api?.repositories.find(
            (candidate) => normalizedPath(candidate.rootUri.fsPath) === root,
        );
        if (!repository) return;

        const displayRoot = this.displayRoots.get(root) ?? root;
        const existing = this.shared.get(root);
        const firstContact = !existing || existing.base === undefined;
        const record = existing ?? this.createRecord(root);
        const native = repository.inputBox.value;
        this.reconcile(displayRoot, repository, record, native, firstContact);
        this.deliver(root, displayRoot, record.base);
    }

    private createRecord(root: string): SharedNativeCommitInputRecord {
        const record = { pending: false };
        this.shared.set(root, record);
        return record;
    }

    private reconcile(
        displayRoot: string,
        repository: VsCodeGitRepository,
        record: SharedNativeCommitInputRecord,
        native: string,
        firstContact: boolean,
    ): void {
        if (firstContact) {
            this.reconcileFirstContact(displayRoot, repository, record, native);
            return;
        }
        if (native !== record.base) {
            this.adopt(displayRoot, record, native);
            return;
        }
        if (record.pending) this.push(displayRoot, repository, record, native);
    }

    private reconcileFirstContact(
        displayRoot: string,
        repository: VsCodeGitRepository,
        record: SharedNativeCommitInputRecord,
        native: string,
    ): void {
        if (record.pending || native === "") {
            this.push(displayRoot, repository, record, native);
            return;
        }

        this.adopt(displayRoot, record, native);
    }

    private push(
        displayRoot: string,
        repository: VsCodeGitRepository,
        record: SharedNativeCommitInputRecord,
        native: string,
    ): void {
        const stored = this.readDraft(displayRoot);
        if (native !== stored) repository.inputBox.value = stored;
        record.base = stored;
        record.pending = false;
    }

    private adopt(
        displayRoot: string,
        record: SharedNativeCommitInputRecord,
        native: string,
    ): void {
        record.base = native;
        record.pending = false;
        this.persistDraft(displayRoot, native);
    }

    private deliver(root: string, displayRoot: string, base: string | undefined): void {
        if (this.seen.get(root) === base) return;
        this.seen.set(root, base);
        this.onNativeChange(displayRoot, base ?? "");
    }

    /**
     * Start or stop polling; the interval is idempotent and showing performs one immediate tick.
     *
     * // ponytail: replace polling with an input-box change event if the Git extension adds one.
     */
    public setVisible(visible: boolean): void {
        if (this.disposed) return;
        if (!visible) {
            if (this.interval) clearInterval(this.interval);
            this.interval = undefined;
            return;
        }

        if (!this.interval) {
            this.interval = setInterval(() => this.tick(), this.pollIntervalMs);
        }
        this.tick();
    }

    /** Stop polling, ignore late API resolution, and forget this bridge's roots. */
    public dispose(): void {
        if (this.interval) clearInterval(this.interval);
        this.interval = undefined;
        this.disposed = true;
        this.attachedRoots.clear();
        this.displayRoots.clear();
        this.seen.clear();
    }

    /** Mirror text written by this bridge's panel into the native input box when possible. */
    public setFromPanel(root: string, message: string): void {
        if (this.disposed) return;
        const key = normalizedPath(root);
        if (!this.attachedRoots.has(key)) return;

        this.seen.set(key, message);
        const record = this.shared.get(key);

        try {
            const repository = this.api?.repositories.find(
                (candidate) => normalizedPath(candidate.rootUri.fsPath) === key,
            );
            if (!repository || !record || record.base === undefined) {
                const placeholder = record ?? { pending: false };
                placeholder.pending = true;
                this.shared.set(key, placeholder);
                return;
            }

            if (repository.inputBox.value !== message) repository.inputBox.value = message;
            record.base = message;
            record.pending = false;
        } catch (error: unknown) {
            const pendingRecord = record ?? { pending: false };
            pendingRecord.pending = true;
            this.shared.set(key, pendingRecord);
            this.logRootError(key, error);
        }
    }

    private logResolveError(error: unknown): void {
        console.error("[IntelliGit] Failed to resolve VS Code Git API:", error);
    }

    private logRootError(root: string, error: unknown): void {
        if (this.loggedRootErrors.has(root)) return;
        this.loggedRootErrors.add(root);
        console.error("[IntelliGit] Native commit input bridge failed for " + root + ":", error);
    }
}

async function defaultResolveApi(): Promise<VsCodeGitApi | undefined> {
    const extension = vscode.extensions?.getExtension<VsCodeGitExtension>("vscode.git");
    if (!extension) return undefined;
    const git = await extension.activate();
    if (git.enabled === false) return undefined;
    return git.getAPI(1);
}
