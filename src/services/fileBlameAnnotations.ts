import * as vscode from "vscode";
import { blameDate, parseBlame, type BlameLine } from "../git/blame";
import { GitExecutor } from "../git/executor";
import { getErrorMessage } from "../utils/errors";
import { subscribeToRepositoryWorkingTreeChanges } from "./repositoryChangeEvents";

/** Captured local file identity supplied by the existing file-context resolver. */
export interface BlameTarget {
    readonly selectedUri: vscode.Uri;
    readonly repoRoot: string;
    readonly repoRelativePath: string;
}

interface BlameSession {
    readonly target: BlameTarget;
    readonly document: vscode.TextDocument;
    readonly executor: GitExecutor;
    readonly editors: Set<vscode.TextEditor>;
    readonly controller: AbortController;
    subscription?: vscode.Disposable;
    timer?: ReturnType<typeof setTimeout>;
    running?: Promise<void>;
    generation: number;
    version: number;
    lines: BlameLine[];
}

const MAX_BLAME_BYTES = 4 * 1024 * 1024;
const REFRESH_DELAY_MS = 300;
const services = new WeakMap<vscode.ExtensionContext, FileBlameAnnotations>();

/** Lazily owns one editor annotation service for an extension activation. */
export function getFileBlameAnnotations(context: vscode.ExtensionContext): FileBlameAnnotations {
    let service = services.get(context);
    if (!service) {
        service = new FileBlameAnnotations();
        services.set(context, service);
        context.subscriptions.push(service);
    }
    return service;
}

/** Toggles native line-start blame decorations without replacing or modifying source documents. */
export class FileBlameAnnotations implements vscode.Disposable {
    private readonly sessions = new Map<string, BlameSession>();
    private readonly decoration: vscode.TextEditorDecorationType;
    private readonly listeners: vscode.Disposable[];
    private disposed = false;

    /** Registers activation-scoped editor listeners and the shared decoration style. */
    constructor() {
        this.decoration = vscode.window.createTextEditorDecorationType({
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            before: {
                width: "38ch",
                margin: "0 1.5em 0 0",
                color: new vscode.ThemeColor("descriptionForeground"),
                backgroundColor: new vscode.ThemeColor("editorGutter.background"),
                textDecoration:
                    "none; white-space: pre; overflow: hidden; text-overflow: ellipsis; vertical-align: middle;",
            },
        });
        this.listeners = [
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.contentChanges.length > 0) this.documentChanged(event.document);
            }),
            vscode.workspace.onDidSaveTextDocument((document) => this.documentChanged(document)),
            vscode.workspace.onDidCloseTextDocument((document) => this.hide(document.uri)),
            vscode.window.onDidChangeVisibleTextEditors(() => {
                for (const session of this.sessions.values()) this.render(session);
            }),
        ];
    }

    /** Shows annotations in the clicked source file, or hides an existing file's annotations. */
    async toggle(target: BlameTarget): Promise<void> {
        if (this.disposed) return;
        const key = target.selectedUri.toString();
        if (this.sessions.has(key)) {
            this.hide(target.selectedUri);
            return;
        }
        const editor = await vscode.window.showTextDocument(target.selectedUri, { preview: false });
        if (this.disposed) return;
        // A second invocation may have opened the same editor while this one awaited VS Code.
        if (this.sessions.has(key)) {
            this.hide(target.selectedUri);
            return;
        }
        const session: BlameSession = {
            target,
            document: editor.document,
            executor: new GitExecutor(target.repoRoot),
            editors: new Set([editor]),
            controller: new AbortController(),
            generation: 0,
            version: -1,
            lines: [],
        };
        this.sessions.set(key, session);
        session.subscription = subscribeToRepositoryWorkingTreeChanges(target.repoRoot, (event) => {
            if (event.source !== "workspace-file" || event.path === target.repoRelativePath) {
                this.schedule(session);
            }
        });
        try {
            await this.refresh(session);
        } catch (error) {
            if (!this.isCurrent(session)) return;
            this.hide(target.selectedUri);
            throw error;
        }
    }

    /** Removes sessions, pending timers, repository subscriptions, and editor decorations. */
    dispose(): void {
        this.disposed = true;
        for (const session of this.sessions.values()) this.hide(session.target.selectedUri);
        for (const listener of this.listeners) listener.dispose();
        this.decoration.dispose();
    }

    private isCurrent(session: BlameSession): boolean {
        return this.sessions.get(session.target.selectedUri.toString()) === session;
    }

    private hide(uri: vscode.Uri): void {
        const session = this.sessions.get(uri.toString());
        if (!session) return;
        this.sessions.delete(uri.toString());
        session.generation += 1;
        if (session.timer) clearTimeout(session.timer);
        session.subscription?.dispose();
        session.controller.abort();
        this.clearEditors(session);
    }

    private documentChanged(document: vscode.TextDocument): void {
        const session = this.sessions.get(document.uri.toString());
        if (session) this.schedule(session);
    }

    private clearEditors(session: BlameSession): void {
        for (const editor of session.editors) {
            editor.setDecorations(this.decoration, []);
        }
    }

    private schedule(session: BlameSession): void {
        session.generation += 1;
        session.version = -1;
        this.clearEditors(session);
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            session.timer = undefined;
            void this.refresh(session).catch((error: unknown) => {
                if (!this.isCurrent(session)) return;
                this.hide(session.target.selectedUri);
                void vscode.window.showErrorMessage(
                    vscode.l10n.t("Annotate with Git Blame failed: {message}", {
                        message: getErrorMessage(error),
                    }),
                );
            });
        }, REFRESH_DELAY_MS);
    }

    private async refresh(session: BlameSession): Promise<void> {
        if (session.running) return session.running;
        const running = this.load(session);
        session.running = running;
        try {
            await running;
        } finally {
            session.running = undefined;
        }
    }

    private async load(session: BlameSession): Promise<void> {
        while (this.isCurrent(session)) {
            const generation = session.generation;
            const version = session.document.version;
            const text = session.document.getText();
            if (text.includes("\0")) throw new Error("Git blame requires a text file.");
            const input = Buffer.from(text, "utf8");
            if (input.length > MAX_BLAME_BYTES) {
                throw new Error(
                    vscode.l10n.t("Git Blame output is too large to open (maximum 4 MiB)."),
                );
            }
            const result = await session.executor.runBinary(
                ["blame", "--porcelain", "--contents", "-", "--", session.target.repoRelativePath],
                { input, maxOutputBytes: MAX_BLAME_BYTES, signal: session.controller.signal },
            );
            if (!this.isCurrent(session)) return;
            if (generation !== session.generation || version !== session.document.version) continue;
            if (result.truncated) {
                throw new Error(
                    vscode.l10n.t("Git Blame output is too large to open (maximum 4 MiB)."),
                );
            }
            session.lines = parseBlame(result.stdout.toString("utf8"));
            session.version = version;
            this.render(session);
            return;
        }
    }

    private render(session: BlameSession): void {
        if (session.version !== session.document.version) return;
        const decorations = session.lines
            .filter((line) => line.line >= 0 && line.line < session.document.lineCount)
            .map((line): vscode.DecorationOptions => {
                const uncommitted = /^0+$/.test(line.commit);
                const author = uncommitted ? vscode.l10n.t("Uncommitted changes") : line.author;
                const date = uncommitted ? "" : blameDate(line);
                const commit = uncommitted ? "" : line.commit.slice(0, 8);
                const label = `${commit.padEnd(8)} ${date.padEnd(10)} ${author}`;
                const hover = new vscode.MarkdownString();
                hover.appendText(uncommitted ? author : `${line.author} (${date})`);
                if (!uncommitted) {
                    hover.appendMarkdown("\n\n");
                    hover.appendText(line.commit);
                    hover.appendMarkdown("\n\n");
                    hover.appendText(line.summary);
                }
                return {
                    range: new vscode.Range(line.line, 0, line.line, 0),
                    hoverMessage: hover,
                    renderOptions: { before: { contentText: label } },
                };
            });
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document === session.document) {
                session.editors.add(editor);
                editor.setDecorations(this.decoration, decorations);
            }
        }
    }
}
