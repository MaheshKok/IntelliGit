import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    let documentChangeListener: ((event: { document: unknown }) => void) | undefined;
    let messageListener: ((message: unknown) => void) | undefined;
    let panelDisposeListener: (() => void) | undefined;

    class WorkspaceEdit {
        replacements: Array<{ uri: unknown; range: { start: number; end: number }; text: string }> =
            [];

        replace(uri: unknown, range: { start: number; end: number }, text: string): void {
            this.replacements.push({ uri, range, text });
        }
    }

    class Range {
        constructor(
            readonly start: number,
            readonly end: number,
        ) {}
    }

    return {
        WorkspaceEdit,
        Range,
        executeCommand: vi.fn(),
        applyEdit: vi.fn(),
        writeFile: vi.fn(),
        // Resolves a boolean for the same reason `postMessage` below does: `TextDocument.save`
        // reports a refused save by RESOLVING false, never by rejecting, so a bare `vi.fn()`
        // resolving `undefined` is a value the contract cannot produce — and one that reads as
        // failure to any code that checks it.
        save: vi.fn().mockResolvedValue(true),
        registerCustomEditorProvider: vi.fn(() => ({ dispose: vi.fn() })),
        logGitOpsWarning: vi.fn(),
        // Resolves a boolean because the real `postMessage` does, and that return value is
        // load-bearing: it is how the API reports a dropped message. A bare `vi.fn()` resolves
        // `undefined`, which is not a value the contract can produce — and while it stood, no
        // test could express delivery succeeding or failing at all, which is what let a
        // dropped payload read as a delivered one through two rounds of review.
        postMessage: vi.fn().mockResolvedValue(true),
        onDidChangeTextDocument: vi.fn((listener) => {
            documentChangeListener = listener;
            return { dispose: vi.fn() };
        }),
        onDidReceiveMessage: vi.fn((listener) => {
            messageListener = listener;
            return { dispose: vi.fn() };
        }),
        onDidDispose: vi.fn((listener: () => void) => {
            panelDisposeListener = listener;
            return { dispose: vi.fn() };
        }),
        // `contentChanges` is never absent on the real event. It is carried faithfully even
        // though the provider discriminates on `version`, so a test can express the shape VS
        // Code actually sends for an EOL switch: no content changes, but a new version.
        emitDocumentChange: (document: unknown, contentChanges: unknown[] = [{}]) =>
            documentChangeListener?.({ document, contentChanges }),
        sendWebviewMessage: (message: unknown) => messageListener?.(message),
        firePanelDispose: () => panelDisposeListener?.(),
    };
});

vi.mock("vscode", () => ({
    commands: { executeCommand: mocks.executeCommand },
    workspace: {
        applyEdit: mocks.applyEdit,
        onDidChangeTextDocument: mocks.onDidChangeTextDocument,
        fs: { writeFile: mocks.writeFile },
    },
    WorkspaceEdit: mocks.WorkspaceEdit,
    Range: mocks.Range,
    Uri: { joinPath: (uri: unknown) => uri },
    EndOfLine: { LF: 1, CRLF: 2 },
    env: { language: "en" },
    l10n: { t: (message: string) => message },
    window: { registerCustomEditorProvider: mocks.registerCustomEditorProvider },
}));
vi.mock("../../../src/git/operationSupport", () => ({
    logGitOpsWarning: mocks.logGitOpsWarning,
}));

import {
    EditableDiffEditorProvider,
    registerEditableDiffEditorProvider,
} from "../../../src/views/EditableDiffEditorProvider";

describe("EditableDiffEditorProvider", () => {
    let documentText: string;
    let documentDirty: boolean;
    let documentVersion: number;
    let documentEol: number;
    // One-shot, because the failure being modelled is transient: `buildData` reads the
    // document and diffs it, and the diff's LCS pass allocates a large `Int32Array`. An
    // allocation that fails under memory pressure succeeds on the retry, which is exactly
    // what makes the missing re-arm fatal rather than merely noisy — the pane could have
    // recovered and does not.
    let getTextFailure: Error | null = null;
    const diskText = "saved();\n";
    const uri = { toString: () => "file:///repo/src/a.ts" };
    const document = {
        uri,
        getText: () => {
            if (getTextFailure) {
                const failure = getTextFailure;
                getTextFailure = null;
                throw failure;
            }
            return documentText;
        },
        get isDirty() {
            return documentDirty;
        },
        get version() {
            return documentVersion;
        },
        get eol() {
            return documentEol;
        },
        positionAt: (offset: number) => offset,
        save: mocks.save,
    };
    const panel = {
        title: "",
        dispose: vi.fn(),
        webview: {
            html: "",
            options: {},
            cspSource: "webview-csp",
            asWebviewUri: (value: unknown) => ({ toString: () => String(value) }),
            postMessage: mocks.postMessage,
            onDidReceiveMessage: mocks.onDidReceiveMessage,
        },
        onDidDispose: mocks.onDidDispose,
    };

    const openDescriptor = {
        path: "src/a.ts",
        title: "Diff",
        leftLabel: "HEAD",
        rightLabel: "Working tree",
        languageId: "typescript",
        editablePane: "right" as const,
        immutableText: "head();\n",
    };
    const newProvider = (): EditableDiffEditorProvider =>
        new EditableDiffEditorProvider({ toString: () => "file:///extension" } as never);
    const tokenNow = (): number => {
        const calls = mocks.postMessage.mock.calls;
        const last = calls[calls.length - 1]?.[0] as {
            data?: { editableReseedToken?: number };
        };
        return last?.data?.editableReseedToken ?? -1;
    };
    // Renders are coalesced onto a microtask, so each assertion must let one land —
    // otherwise both would read the payload from the initial render and pass vacuously.
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    // The host creates no webview until `resolveCustomTextEditor` returns, so the first payload
    // is pulled by the webview rather than pushed by the provider: `DiffViewerApp` posts `ready`
    // once it mounts and the session renders in response. Driving both steps here is what makes
    // these tests exercise the sequence production actually performs.
    const resolveAndBoot = async (provider: EditableDiffEditorProvider): Promise<void> => {
        await provider.resolveCustomTextEditor(document as never, panel as never, {} as never);
        mocks.sendWebviewMessage({ type: "ready" });
        await settle();
    };
    const sendEdit = async (text: string, baseVersion = documentVersion): Promise<void> => {
        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text,
                baseVersion,
                baseReseedToken: tokenNow(),
            },
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
        panel.title = "";
        getTextFailure = null;
        documentText = diskText;
        documentDirty = false;
        documentVersion = 1;
        documentEol = 1;
        mocks.applyEdit.mockImplementation(
            async (edit: InstanceType<typeof mocks.WorkspaceEdit>) => {
                const replacement = edit.replacements[0];
                documentText =
                    documentText.slice(0, replacement.range.start) +
                    replacement.text +
                    documentText.slice(replacement.range.end);
                documentDirty = true;
                documentVersion += 1;
                mocks.emitDocumentChange(document);
                return true;
            },
        );
    });

    it("registers editable diffs with VS Code's find widget enabled", () => {
        const registration = registerEditableDiffEditorProvider({
            extensionUri: { toString: () => "file:///extension" },
            subscriptions: [],
        } as never);

        expect(mocks.registerCustomEditorProvider).toHaveBeenCalledWith(
            "intelligit.editableDiff",
            expect.any(EditableDiffEditorProvider),
            expect.objectContaining({
                webviewOptions: expect.objectContaining({ enableFindWidget: true }),
            }),
        );
        registration.dispose();
    });

    it("resolves the editor without awaiting a reply the host cannot deliver yet", async () => {
        // VS Code creates no webview until `resolveCustomTextEditor` returns, so nothing posted
        // from inside it can be delivered, and awaiting that delivery is a circular wait: the
        // open never completes, and the editor tab sits blank with its title already applied and
        // no error raised anywhere. Every other test in this file mocks `postMessage` as
        // already-resolved, which removes exactly the circularity that fails in the real host.
        const provider = newProvider();
        await provider.open(uri as never, { ...openDescriptor, onSessionDisposed: vi.fn() });
        mocks.postMessage.mockReturnValue(new Promise<boolean>(() => undefined));

        let resolved = false;
        void provider
            .resolveCustomTextEditor(document as never, panel as never, {} as never)
            .then(() => {
                resolved = true;
            });
        await settle();
        // `vi.clearAllMocks()` in beforeEach clears recorded calls, not implementations, so this
        // stub would otherwise hang every later test in the file.
        mocks.postMessage.mockResolvedValue(true);

        expect(resolved, "resolveCustomTextEditor must not await a webview reply").toBe(true);
    });

    it("writes a webview delta through the VS Code document and re-renders document changes", async () => {
        const provider = new EditableDiffEditorProvider({
            toString: () => "file:///extension",
        } as never);
        await provider.open(uri as never, {
            path: "src/a.ts",
            title: "Diff",
            leftLabel: "HEAD",
            rightLabel: "Working tree",
            languageId: "typescript",
            editablePane: "right",
            immutableText: "head();\n",
            onSessionDisposed: vi.fn(),
        });
        await resolveAndBoot(provider);
        expect(mocks.postMessage.mock.calls.at(-1)?.[0]).not.toHaveProperty(
            "data.onSessionDisposed",
        );

        vi.useFakeTimers();
        try {
            await sendEdit("dirty");
            await vi.advanceTimersByTimeAsync(0);

            expect(document.getText()).toBe("dirty();\n");
            // The edit must reach the file ONLY as a WorkspaceEdit against the live document:
            // that is what leaves the buffer dirty and the file on disk untouched until the user
            // saves. Asserting the `diskText` literal instead would compare a const to itself and
            // pass no matter what this provider did, so the disk oracle is the write APIs it must
            // not reach for.
            expect(mocks.applyEdit).toHaveBeenCalledOnce();
            expect(mocks.writeFile).not.toHaveBeenCalled();
            expect(mocks.save).not.toHaveBeenCalled();
            expect(
                mocks.executeCommand.mock.calls.some(
                    ([command]) => typeof command === "string" && /save/i.test(command),
                ),
            ).toBe(false);

            await vi.advanceTimersByTimeAsync(2000);
            expect(mocks.save).toHaveBeenCalledOnce();
            // The other direction of the same guard. A save that succeeded must say nothing:
            // without this, a check inverted to treat `true` as the failure would leave every
            // test in this file green while every ordinary save wrote a warning to the user's
            // output channel.
            expect(mocks.logGitOpsWarning).not.toHaveBeenCalledWith(
                "editableDiffEditorProvider.autoSave",
                expect.anything(),
            );
        } finally {
            vi.useRealTimers();
        }
        await vi.waitFor(() => {
            expect(mocks.postMessage).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    type: "setDiffData",
                    data: expect.objectContaining({
                        editablePane: "right",
                        editableText: "dirty();\n",
                    }),
                }),
            );
        });

        documentText = "external();\nunsaved();\n";
        documentDirty = true;
        documentVersion += 1;
        mocks.emitDocumentChange(document);

        await vi.waitFor(() => {
            expect(mocks.postMessage).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    type: "setDiffData",
                    data: expect.objectContaining({ editableText: "external();\nunsaved();\n" }),
                }),
            );
        });
    });

    it("restarts the auto-save window after another landed edit", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);

        vi.useFakeTimers();
        try {
            await sendEdit("first");
            await vi.advanceTimersByTimeAsync(1000);
            await sendEdit("again");
            await vi.advanceTimersByTimeAsync(1000);

            expect(mocks.save).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1000);
            expect(mocks.save).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not save when the document is clean when the auto-save timer fires", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);

        vi.useFakeTimers();
        try {
            await sendEdit("clean");
            await vi.advanceTimersByTimeAsync(0);
            documentDirty = false;

            await vi.advanceTimersByTimeAsync(2000);
            expect(mocks.save).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not arm auto-save for a rejected delta", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);

        vi.useFakeTimers();
        try {
            await sendEdit("dropped", documentVersion - 1);
            await vi.advanceTimersByTimeAsync(2000);

            expect(mocks.save).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("cancels auto-save when the editable diff session is disposed", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);

        vi.useFakeTimers();
        try {
            await sendEdit("gone");
            await vi.advanceTimersByTimeAsync(0);
            expect(vi.getTimerCount()).toBe(1);
            mocks.firePanelDispose();
            expect(vi.getTimerCount()).toBe(0);

            await vi.advanceTimersByTimeAsync(2000);
            expect(mocks.save).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("logs and swallows an auto-save failure", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const error = new Error("save failed");
        mocks.save.mockRejectedValueOnce(error);

        vi.useFakeTimers();
        try {
            await sendEdit("error");
            await vi.advanceTimersByTimeAsync(2000);

            expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
                "editableDiffEditorProvider.autoSave",
                error,
            );
        } finally {
            vi.useRealTimers();
        }
    });

    // The failure shape the `catch` above cannot see. `TextDocument.save` resolves `false` for a
    // refused save — a read-only file, a full disk, a folder that vanished — and rejects only for
    // an exceptional fault, so the whole ordinary failure surface arrives as a resolved value.
    // The document is still dirty afterwards and the timer has already been cleared, so nothing
    // retries: the user believes their edit is on disk and it is not. This is the same swallowed
    // boolean the `postMessage` mock at the top of this file carries a comment about, and it was
    // written into this provider once already.
    it("logs an auto-save the editor refuses without rejecting", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        mocks.save.mockResolvedValueOnce(false);

        vi.useFakeTimers();
        try {
            await sendEdit("refused");
            await vi.advanceTimersByTimeAsync(2000);

            expect(mocks.save).toHaveBeenCalledOnce();
            expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
                "editableDiffEditorProvider.autoSave",
                expect.objectContaining({
                    message: "VS Code reported the document save as failed.",
                }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("advances the reseed token for an external change but not for its own edit", async () => {
        const provider = new EditableDiffEditorProvider({
            toString: () => "file:///extension",
        } as never);
        await provider.open(uri as never, {
            path: "src/a.ts",
            title: "Diff",
            leftLabel: "HEAD",
            rightLabel: "Working tree",
            languageId: "typescript",
            editablePane: "right",
            immutableText: "head();\n",
        });
        await resolveAndBoot(provider);

        const initialToken = tokenNow();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "typed",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        // The webview already shows what it typed. Reseeding here would roll the pane back
        // to whichever delta finished round-tripping and silently drop the rest.
        expect(mocks.postMessage.mock.calls.length).toBeGreaterThan(1);
        expect(tokenNow()).toBe(initialToken);

        documentText = "someone-else();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        // An edit from anywhere else must win over the draft, so the token has to move.
        expect(tokenNow()).toBe(initialToken + 1);
    });

    it("reseeds for a foreign write that lands while our own edit is still in flight", async () => {
        let releaseEdit: (() => void) | undefined;
        mocks.applyEdit.mockImplementation(async () => {
            await new Promise<void>((resolve) => {
                releaseEdit = resolve;
            });
            return true;
        });
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();

        void mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "typed",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        // A formatter, a language server, or this file's plain editor writing here is
        // indistinguishable from our own echo to a flag held across the applyEdit await —
        // and that misattribution leaves the pane rendering a version of the file that no
        // longer exists.
        documentText = "someone-else();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        expect(tokenNow()).toBe(initialToken + 1);
        releaseEdit?.();
    });

    it("does not reseed when its own edit echoes back after applyEdit has resolved", async () => {
        // VS Code delivers the change event from the main thread, so it is not contractually
        // inside the applyEdit round trip. A flag cleared when the await returns calls this
        // echo foreign, which rolls the pane back and drops everything typed since.
        mocks.applyEdit.mockImplementation(
            async (edit: InstanceType<typeof mocks.WorkspaceEdit>) => {
                const replacement = edit.replacements[0];
                documentText =
                    documentText.slice(0, replacement.range.start) +
                    replacement.text +
                    documentText.slice(replacement.range.end);
                documentVersion += 1;
                return true;
            },
        );
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "typed",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();
        mocks.emitDocumentChange(document);
        await settle();

        expect(document.getText()).toBe("typed();\n");
        expect(tokenNow()).toBe(initialToken);
    });

    it("keeps writing later deltas after one applyEdit rejects", async () => {
        // `.then` on a rejected promise skips its callback for good, so an unhandled failure
        // here wedges the queue: the webview keeps accepting keystrokes the document never
        // receives, and nothing on screen says so.
        let attempts = 0;
        mocks.applyEdit.mockImplementation(
            async (edit: InstanceType<typeof mocks.WorkspaceEdit>) => {
                attempts += 1;
                if (attempts === 1) throw new Error("applyEdit exploded");
                const replacement = edit.replacements[0];
                documentText =
                    documentText.slice(0, replacement.range.start) +
                    replacement.text +
                    documentText.slice(replacement.range.end);
                documentVersion += 1;
                mocks.emitDocumentChange(document);
                return true;
            },
        );
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "one",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        // The webview listener discards the handler's promise, so awaiting the send only
        // yields one microtask — the queued edit has not run yet.
        await settle();
        // The failure reseeded, so the pane the next keystroke is measured against is the one
        // the host just re-sent. A second delta still stamped with the pre-failure token would
        // be a delta measured against text the host has already declared void.
        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "two",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(mocks.applyEdit).toHaveBeenCalledTimes(2);
        expect(document.getText()).toBe("two();\n");
        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "editableDiffEditorProvider.applyEdit",
            expect.any(Error),
        );
        // Exactly one bump: the throw reseeds, and the delta that then succeeds must be
        // recognized as our own echo rather than counted as somebody else's write.
        expect(tokenNow()).toBe(initialToken + 1);
    });

    it("still recognizes its own echo after a rejected edit left an expectation behind", async () => {
        // The rejected edit's expectation can never be satisfied. Left in the queue it sits at
        // the head and swallows the NEXT edit's echo, which then reads as a foreign write and
        // reseeds the pane out from under whatever the user typed in between.
        let attempts = 0;
        mocks.applyEdit.mockImplementation(
            async (edit: InstanceType<typeof mocks.WorkspaceEdit>) => {
                attempts += 1;
                if (attempts === 1) return false;
                const replacement = edit.replacements[0];
                documentText =
                    documentText.slice(0, replacement.range.start) +
                    replacement.text +
                    documentText.slice(replacement.range.end);
                documentVersion += 1;
                mocks.emitDocumentChange(document);
                return true;
            },
        );
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "one",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();
        const tokenAfterRejection = tokenNow();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "two",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(tokenAfterRejection).toBe(initialToken + 1);
        expect(document.getText()).toBe("two();\n");
        expect(tokenNow()).toBe(tokenAfterRejection);
    });

    it("maps a CRLF document's offsets out of the LF space the textarea reports", async () => {
        // A `<textarea>`'s API value normalizes CRLF and lone CR to LF, so the webview measures
        // every delta in a coordinate space the document is not in. Applying those offsets raw
        // lands the edit inside a line terminator and splits it.
        documentText = "a\r\nb\r\nc";
        documentEol = 2;
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();

        expect(mocks.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
            data: { editableText: "a\nb\nc" },
        });

        // Appending "X" at the end of the LF text, which is offset 5 there and 7 here.
        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 5,
                endOffset: 5,
                text: "X",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(document.getText()).toBe("a\r\nb\r\ncX");
        // Its own echo, so the draft must survive: a reseed here discards every keystroke
        // typed while the edit was in flight.
        expect(tokenNow()).toBe(initialToken);
    });

    it("inserts a newline in the document's own EOL rather than a lone LF", async () => {
        documentText = "a\r\nb\r\nc";
        documentEol = 2;
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 1,
                endOffset: 1,
                text: "\n",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(document.getText()).toBe("a\r\n\r\nb\r\nc");
        expect(tokenNow()).toBe(initialToken);
    });

    it("maps offsets through a document that mixes CRLF and lone CR", async () => {
        // `vscode.EndOfLine` has two members, so it cannot describe this file at all — which is
        // why the mapping walks the text instead of computing from `document.eol`. A walk that
        // trusted the declared EOL would treat the lone CR as a pair and step over its neighbour.
        documentText = "a\r\nb\rc\nd";
        documentEol = 2;
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();

        expect(mocks.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
            data: { editableText: "a\nb\nc\nd" },
        });

        // LF offset 5 is the terminator after `c`; in the document that is offset 6, and only a
        // walk finds it — the lone CR at raw offset 4 is one character, not two.
        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 5,
                endOffset: 5,
                text: "Z",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(document.getText()).toBe("a\r\nb\rcZ\nd");
        expect(tokenNow()).toBe(initialToken);
    });

    it("ignores a change event that did not move the document version", async () => {
        documentText = "typed();\n";
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();
        const rendersBefore = mocks.postMessage.mock.calls.length;

        // VS Code delivers dirty-state flips through this same event: no content change, and
        // no new version. The expectation queue is empty by then, so treating one as a foreign
        // write would reseed the pane and drop every delta still in flight.
        mocks.emitDocumentChange(document, []);
        await settle();

        expect(tokenNow()).toBe(initialToken);
        expect(mocks.postMessage.mock.calls.length).toBe(rendersBefore);
    });

    it("reseeds for an EOL switch even though it reports no content changes", async () => {
        documentText = "a\nb\n";
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();

        // Changing a file's line endings rewrites every terminator and bumps the version, but
        // reports `contentChanges: []`. Keying off that empty array instead of the version
        // would skip this event, leaving the pane measuring against text nobody holds — so the
        // next keystroke would carry a stale baseVersion and be dropped.
        documentText = "a\r\nb\r\n";
        documentEol = 2;
        documentVersion += 1;
        mocks.emitDocumentChange(document, []);
        await settle();

        expect(tokenNow()).toBe(initialToken + 1);
        expect(mocks.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
            data: { editableText: "a\nb\n", documentVersion },
        });
    });

    it("keeps a live editor when only revealing its tab fails", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        mocks.postMessage.mockClear();
        mocks.executeCommand.mockRejectedValueOnce(new Error("cannot reveal"));

        // The editor is already on screen and `update()` has already rendered this descriptor
        // into it. Letting the reveal failure escape sends the caller to its native fallback,
        // which opens a second diff for a file that is already showing one.
        await expect(
            provider.open(uri as never, { ...openDescriptor, title: "Revealed" }),
        ).resolves.toBeUndefined();

        expect(mocks.postMessage).toHaveBeenCalledOnce();
        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "editableDiffEditorProvider.reveal",
            expect.any(Error),
        );
    });

    it("labels the editor tab from the descriptor on the very first open", async () => {
        panel.title = "";
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);

        // The webview shell's `<title>` is not the tab label, so without an explicit assignment
        // the tab keeps VS Code's document-derived name until some later `open()` relabels it.
        expect(panel.title).toBe("Diff");
    });

    it("releases the diff session and forgets the editor when its panel closes", async () => {
        const onSessionDisposed = vi.fn();
        const provider = newProvider();
        await provider.open(uri as never, { ...openDescriptor, onSessionDisposed });
        await resolveAndBoot(provider);

        mocks.firePanelDispose();

        expect(onSessionDisposed).toHaveBeenCalledOnce();
        // A retained session would keep answering for a panel VS Code has already destroyed:
        // re-opening this file would drive the dead panel instead of building a new one, so
        // the title it adopts is the oracle for whether the entry was really dropped.
        panel.title = "closed";
        await provider.open(uri as never, { ...openDescriptor, title: "Reopened" });
        expect(panel.title).toBe("closed");
    });

    it("releases the diff session once when both owners tear the session down", async () => {
        const onSessionDisposed = vi.fn();
        const provider = newProvider();
        await provider.open(uri as never, { ...openDescriptor, onSessionDisposed });
        await resolveAndBoot(provider);

        // Closing the window with an editor open runs both: activation disposal walks every
        // session it still holds, and VS Code then destroys the panel. Provider teardown
        // drops the map entry but cannot unhook the panel listener, so the listener still
        // fires and disposes a session that is already dead.
        provider.dispose();
        mocks.firePanelDispose();

        expect(onSessionDisposed).toHaveBeenCalledOnce();
    });

    it("rejects a second delta that was measured against a stale document version", async () => {
        documentText = "hello";
        documentVersion = 7;
        mocks.applyEdit.mockImplementation(
            async (edit: InstanceType<typeof mocks.WorkspaceEdit>) => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                const replacement = edit.replacements[0];
                documentText =
                    documentText.slice(0, replacement.range.start) +
                    replacement.text +
                    documentText.slice(replacement.range.end);
                documentDirty = true;
                documentVersion += 1;
                mocks.emitDocumentChange(document);
                return true;
            },
        );
        const provider = new EditableDiffEditorProvider({
            toString: () => "file:///extension",
        } as never);
        await provider.open(uri as never, {
            path: "src/a.ts",
            title: "Diff",
            leftLabel: "HEAD",
            rightLabel: "Working tree",
            languageId: "typescript",
            editablePane: "right",
            immutableText: "head();\n",
        });
        await resolveAndBoot(provider);

        mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 5,
                endOffset: 5,
                text: "a",
                baseVersion: 7,
                baseReseedToken: tokenNow(),
            },
        });
        mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 5,
                endOffset: 5,
                text: "b",
                baseVersion: 7,
                baseReseedToken: tokenNow(),
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(document.getText()).toBe("helloa");
        expect(mocks.applyEdit).toHaveBeenCalledOnce();
    });

    it("coalesces a burst of document changes into the final render", async () => {
        const provider = new EditableDiffEditorProvider({
            toString: () => "file:///extension",
        } as never);
        await provider.open(uri as never, {
            path: "src/a.ts",
            title: "Diff",
            leftLabel: "HEAD",
            rightLabel: "Working tree",
            languageId: "typescript",
            editablePane: "right",
            immutableText: "head();\n",
        });
        await resolveAndBoot(provider);
        mocks.postMessage.mockClear();

        documentText = "first change\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        documentText = "final change\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await Promise.resolve();

        expect(mocks.postMessage).toHaveBeenCalledOnce();
        expect(mocks.postMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ editableText: "final change\n" }),
            }),
        );
    });

    it("logs a scheduled render that never reached the webview", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        mocks.postMessage.mockClear();
        mocks.postMessage.mockRejectedValueOnce(new Error("the panel is gone"));

        // This is the document-change path, so it runs on every foreign write to a file the
        // viewer is showing — including the last one before a panel that is already tearing
        // down finishes doing so. `void`-ing that promise makes the rejection unhandled in the
        // extension host, where it is attributed to no feature at all.
        documentText = "elsewhere();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "editableDiffEditorProvider.scheduleRender",
            expect.any(Error),
        );
    });

    it("re-arms a reseed whose payload never reached the webview", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();
        mocks.postMessage.mockClear();
        mocks.applyEdit.mockResolvedValue(false);
        mocks.postMessage.mockRejectedValueOnce(new Error("the post did not land"));

        mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "dirty",
                baseVersion: documentVersion,
                baseReseedToken: initialToken,
            },
        });

        // A token this session minted but never delivered is worse than no reseed at all:
        // `applyEdit` drops a superseded delta instead of answering it, on the stated grounds
        // that every minted token does get published. Undelivered, the webview keeps stamping
        // the token it last saw and the host drops every keystroke from here on, silently.
        // The count is the assertion, not the token — the rejected post recorded its payload
        // in the mock too, so reading the last call alone would pass without any re-arm.
        await vi.waitFor(() => {
            expect(mocks.postMessage.mock.calls.length).toBe(2);
        });
        expect(tokenNow()).toBe(initialToken + 1);
        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "editableDiffEditorProvider.reseed",
            expect.any(Error),
        );
    });

    it("re-arms and reports a reseed the host reported as undelivered, not only one that threw", async () => {
        // The twin of the test above, for the failure shape that does NOT throw. A reseed
        // whose post resolves `false` returns through the success path, so a re-arm written
        // inside the `catch` never runs for it and nothing is logged — the pane diverges from
        // the document in silence, and the only recovery left is the user's next keystroke
        // happening to reach the drop branch.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();
        mocks.postMessage.mockClear();
        mocks.applyEdit.mockResolvedValue(false);
        mocks.postMessage.mockResolvedValueOnce(false);

        mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "dirty",
                baseVersion: documentVersion,
                baseReseedToken: initialToken,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postMessage.mock.calls.length).toBe(2);
        });
        expect(tokenNow()).toBe(initialToken + 1);
        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "editableDiffEditorProvider.render",
            expect.any(String),
        );
    });

    it("ignores a superseded payload's delivery result, so it cannot clear a live failure", async () => {
        // `render` has six call sites and nothing serializes them, so two payloads can be in
        // flight at once and nothing orders their resolutions. `deliveryFailed` is one
        // last-writer-wins boolean, so an older post reporting success after a newer one was
        // dropped would erase the newer one's failure — and the drop branch, the only reader,
        // would then find nothing to recover from. That is the unrecoverable direction: the
        // pane rejects every keystroke from then on with nothing left to republish it.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const stale = tokenNow();
        mocks.postMessage.mockClear();

        // Hold the first payload in flight. It carries the token the webview has adopted.
        let releaseStale: ((delivered: boolean) => void) | undefined;
        mocks.postMessage.mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    releaseStale = resolve;
                }),
        );
        void provider.refresh(uri as never, openDescriptor);

        // A foreign write mints the next token, and it is THIS payload the host drops.
        mocks.postMessage.mockResolvedValueOnce(false);
        documentText = "elsewhere();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        // Only now does the held one land, successfully. It describes a draft this session
        // has already voided, so it says nothing about whether the current token arrived.
        releaseStale?.(true);
        await settle();
        mocks.postMessage.mockClear();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "a",
                baseVersion: documentVersion,
                baseReseedToken: stale,
            },
        });
        await settle();

        expect(
            mocks.postMessage,
            "the webview is still on a superseded token and has to be republished to",
        ).toHaveBeenCalledOnce();
    });

    it("republishes a token the webview never received, instead of going silently read-only", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();
        mocks.postMessage.mockClear();
        mocks.postMessage.mockRejectedValueOnce(new Error("the payload did not land"));

        // A foreign write mints a token here, in the document-change handler — the other
        // minting site, and the one `reseed`'s own re-arm does not cover. Its single delivery
        // attempt is the one that fails.
        documentText = "elsewhere();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        // The webview is still on the token it last saw, so this is what its very next
        // keystroke looks like. Dropping it is correct — but dropping it and doing nothing
        // else is not: nothing would ever publish the new token, because the keystrokes that
        // would drive the next render are exactly the ones being dropped. The pane becomes a
        // textarea that accepts typing and writes nothing, forever, with no error surface.
        mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "a",
                baseVersion: documentVersion,
                baseReseedToken: initialToken,
            },
        });

        // The count is the assertion, not the token: the rejected post recorded its payload in
        // the mock too, so reading the last call alone would pass with no republish at all.
        await vi.waitFor(() => {
            expect(mocks.postMessage.mock.calls.length).toBe(2);
        });
        expect(tokenNow()).toBe(initialToken + 1);
        expect(mocks.applyEdit, "and the dropped keystroke stays dropped").not.toHaveBeenCalled();
    });

    it("treats a post the host reports as undelivered the same as one that threw", async () => {
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();
        mocks.postMessage.mockClear();
        // The API reports a dropped message by RESOLVING `false`. Rejection is the disposed
        // panel — the case where nothing is left to save. This is the live panel that simply
        // did not receive it, which is the case the republish exists for, and it produces no
        // exception, no rejection, and no event of any kind.
        mocks.postMessage.mockResolvedValueOnce(false);

        documentText = "elsewhere();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "a",
                baseVersion: documentVersion,
                baseReseedToken: initialToken,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postMessage.mock.calls.length).toBe(2);
        });
        expect(mocks.applyEdit, "and the dropped keystroke stays dropped").not.toHaveBeenCalled();
    });

    it("stops republishing once a payload lands, so recovery is not permanent", async () => {
        // The flag has two halves and only one of them is a failure path. If a delivery that
        // succeeds does not clear it, the session republishes the whole file for every delta
        // it ever drops again — including the ordinary case of typing through a live reseed,
        // which is the moment the user is typing fastest.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        mocks.postMessage.mockResolvedValueOnce(false);

        documentText = "elsewhere();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        // A second foreign write, delivered normally. It carries the current token, so the
        // webview is no longer behind and there is nothing left to re-arm.
        documentText = "again();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();
        const recovered = tokenNow();
        mocks.postMessage.mockClear();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "a",
                baseVersion: documentVersion,
                baseReseedToken: recovered - 1,
            },
        });
        await settle();

        expect(
            mocks.postMessage,
            "the payload landed, so this drop is the normal one and needs no republish",
        ).not.toHaveBeenCalled();
    });

    it("re-renders and logs when VS Code rejects a workspace edit", async () => {
        const provider = new EditableDiffEditorProvider({
            toString: () => "file:///extension",
        } as never);
        await provider.open(uri as never, {
            path: "src/a.ts",
            title: "Diff",
            leftLabel: "HEAD",
            rightLabel: "Working tree",
            languageId: "typescript",
            editablePane: "right",
            immutableText: "head();\n",
        });
        await resolveAndBoot(provider);
        const initialToken = tokenNow();
        mocks.postMessage.mockClear();
        mocks.applyEdit.mockResolvedValue(false);

        mocks.sendWebviewMessage({
            type: "editText",
            // `initialToken`, not `tokenNow()`: the render history was cleared just above to
            // count the reseed's own render, and the draft this delta was measured against was
            // anchored before that clear.
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "dirty",
                baseVersion: documentVersion,
                baseReseedToken: initialToken,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postMessage).toHaveBeenCalledOnce();
            expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
                "editableDiffEditorProvider.applyEdit",
                expect.any(Error),
            );
        });
        // A bare re-render is not enough here. The pane reseeds only on a token change, so
        // without the bump the webview keeps showing a draft the document never accepted and
        // no later payload can pull it back.
        expect(tokenNow()).toBe(initialToken + 1);
    });

    it("enables scripts and scopes webview assets to the bundled dist directory", async () => {
        const provider = new EditableDiffEditorProvider({
            toString: () => "file:///extension",
        } as never);
        await provider.open(uri as never, {
            path: "src/a.ts",
            title: "Diff",
            leftLabel: "HEAD",
            rightLabel: "Working tree",
            languageId: "typescript",
            editablePane: "right",
            immutableText: "head();\n",
        });

        await resolveAndBoot(provider);

        expect(panel.webview.options).toMatchObject({ enableScripts: true });
        expect(panel.webview.options.localResourceRoots).toHaveLength(1);
    });

    it("forgets a pending descriptor when the editor command rejects", async () => {
        const provider = newProvider();
        mocks.executeCommand.mockRejectedValueOnce(new Error("openWith failed"));

        await expect(provider.open(uri as never, openDescriptor)).rejects.toThrow(
            "openWith failed",
        );

        // Only `resolveCustomTextEditor` clears `pending`, so an open that never resolves
        // strands the descriptor and binds it to whatever reopens this file later.
        await provider.resolveCustomTextEditor(document as never, panel as never, {} as never);
        expect(mocks.executeCommand).toHaveBeenCalledWith("vscode.open", uri, { preview: false });
        expect(panel.dispose).toHaveBeenCalledOnce();
    });

    it("rejects a delta whose reseed token predates a foreign write", async () => {
        // The webview mints its own optimistic versions in the document's numeric space, so
        // the two counters can meet again over texts that differ: a foreign write advances the
        // document by one, a delta rejected for staleness advances the draft by one, and the
        // NEXT delta then carries a base version that matches a document it was never measured
        // against. Its offsets land wherever they happen to fall — a silent buffer corruption
        // with nothing logged, which is why the version alone cannot be the only guard.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const staleToken = tokenNow();

        documentText = "FOREIGN();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();
        expect(tokenNow()).toBe(staleToken + 1);

        // Measured against "saved();\n", stamped with the version the foreign write just
        // produced. Applied raw it would replace "FOREI" and leave "typedGN();\n".
        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 5,
                text: "typed",
                baseVersion: documentVersion,
                baseReseedToken: staleToken,
            },
        });
        await settle();

        expect(mocks.applyEdit).not.toHaveBeenCalled();
        expect(document.getText()).toBe("FOREIGN();\n");
    });

    it("applies a delta that carries the reseed token the host last published", async () => {
        // The other direction of the same guard: once the webview has adopted the reseed, its
        // deltas must land again. A guard that rejected on any past reseed would leave the pane
        // permanently read-only after the first external write to the file.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);

        documentText = "FOREIGN();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 7,
                text: "typed",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(mocks.applyEdit).toHaveBeenCalledOnce();
        expect(document.getText()).toBe("typed();\n");
    });

    it("keeps a live editor when re-rendering its new descriptor fails", async () => {
        // Reopening a file that already has an editor re-renders it and then reveals its tab.
        // The reveal's failure is swallowed so a live editor is never doubled by a native
        // fallback — but the re-render sat OUTSIDE that guard, so a post to a panel disposed a
        // tick before `onDidDispose` cleared the map escaped to the caller and produced
        // exactly the double the guard exists to prevent.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        mocks.postMessage.mockRejectedValueOnce(new Error("webview is disposed"));

        await expect(provider.open(uri as never, openDescriptor)).resolves.toBeUndefined();
        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "editableDiffEditorProvider.reveal",
            expect.anything(),
        );
    });

    it("does not move the reseed target while the webview is still catching up to it", async () => {
        // The webview stamps every delta with the token of the payload it has ALREADY adopted,
        // so a keystroke typed while a reseed is in flight necessarily carries the PREVIOUS
        // token. If each of those rejections published a new token of its own, the host would
        // run permanently ahead of the webview: after one foreign write, a typist faster than
        // the payload round trip has every keystroke rejected, the pane snaps back on each
        // one, and nothing is ever written to the document.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const adopted = tokenNow();

        documentText = "FOREIGN();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();
        // The token the foreign write published — the one the webview will adopt next.
        const published = tokenNow();
        expect(published).toBe(adopted + 1);

        for (const text of ["a", "b"]) {
            await mocks.sendWebviewMessage({
                type: "editText",
                delta: {
                    startOffset: 0,
                    endOffset: 0,
                    text,
                    baseVersion: documentVersion,
                    baseReseedToken: adopted,
                },
            });
            await settle();
        }

        // The invariant, and the whole fix: a delta the host cannot use is dropped, never
        // answered with a token the webview has had no chance to see.
        expect(tokenNow()).toBe(published);
        expect(mocks.applyEdit).not.toHaveBeenCalled();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "c",
                baseVersion: documentVersion,
                baseReseedToken: published,
            },
        });
        await settle();

        expect(mocks.applyEdit).toHaveBeenCalledOnce();
        expect(document.getText()).toBe("cFOREIGN();\n");
    });

    it("logs the delta it dropped, so a silent stall names its own cause", async () => {
        // Every other failure path logs. Without this one the cascade above — and any
        // malformed delta — presents as a pane that simply stops accepting input, with
        // nothing in the output channel saying why.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const adopted = tokenNow();

        documentText = "FOREIGN();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();
        mocks.logGitOpsWarning.mockClear();
        mocks.postMessage.mockClear();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "a",
                baseVersion: documentVersion,
                baseReseedToken: adopted,
            },
        });
        await settle();

        // `any(String)`, not `anything()`: `logGitOpsWarning` appends `err.stack` for anything
        // that is an `Error`, and the code's own comment calls this path the normal case — so
        // reporting it as an `Error` would put a full stack trace in the output channel for
        // every keystroke typed during a reseed, burying the failures worth reading.
        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "editableDiffEditorProvider.staleDelta",
            expect.any(String),
        );
        // This is the NORMAL drop — the reseed that voided the draft was delivered, so the
        // webview is already about to adopt it. Republishing here would put a payload of the
        // whole file on the wire for every keystroke typed through a reseed, which is the one
        // moment the user is typing fastest. The republish is for the case the payload did
        // NOT land, and this is what keeps that distinction from collapsing into "always".
        expect(mocks.postMessage, "a delivered reseed needs no republish").not.toHaveBeenCalled();
    });

    it("forgets a pending descriptor that a refresh replaced before the open rejected", async () => {
        // `refresh()` writes a NEW descriptor object into the same pending slot, so the
        // identity check in `open()`'s catch stops matching in exactly the window it exists
        // for. The entry then outlives its failed open and binds to whatever reopens the file.
        let releaseOpen: (() => void) | undefined;
        mocks.executeCommand.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                releaseOpen = resolve;
            });
            throw new Error("no editor");
        });
        const provider = newProvider();
        const opening = provider.open(uri as never, openDescriptor);
        await settle();

        await provider.refresh(uri as never, {
            ...openDescriptor,
            immutableText: "refreshed();\n",
        });
        releaseOpen?.();
        await expect(opening).rejects.toThrow("no editor");

        // Nothing is pending now, so a later restore of this document is not ours to render.
        await resolveAndBoot(provider);
        expect(mocks.executeCommand).toHaveBeenLastCalledWith("vscode.open", uri, {
            preview: false,
        });
        expect(panel.dispose).toHaveBeenCalled();
    });

    it("hands a restored editor with no pending descriptor back to the normal editor", async () => {
        const provider = new EditableDiffEditorProvider({
            toString: () => "file:///extension",
        } as never);

        await resolveAndBoot(provider);

        expect(mocks.executeCommand).toHaveBeenCalledWith("vscode.open", uri, { preview: false });
        expect(panel.dispose).toHaveBeenCalledOnce();
    });

    it("disposes the restored panel even when handing it back fails", async () => {
        // A window restore of a stale custom editor whose file is gone. This branch never
        // assigns `webview.html`, so a panel left alive here is a blank tab the user cannot
        // get rid of by any means the extension offers.
        const provider = newProvider();
        mocks.executeCommand.mockRejectedValueOnce(new Error("file not found"));

        await expect(
            provider.resolveCustomTextEditor(document as never, panel as never, {} as never),
        ).rejects.toThrow("file not found");

        expect(panel.dispose, "a failed handoff must not strand a blank editor").toHaveBeenCalled();
    });

    it("rejects a delta whose offsets are NaN instead of applying it at the top of the file", async () => {
        // NaN is a number, and it fails every range comparison in the validation branch —
        // `NaN < 0`, `NaN < start` and `NaN > length` are all false — so it would clear
        // validation and then map to offset 0.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: Number.NaN,
                endOffset: Number.NaN,
                text: "X",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(mocks.applyEdit, "a NaN offset is not a position").not.toHaveBeenCalled();
        expect(document.getText()).toBe(diskText);
    });

    it("keeps accepting edits after a failed edit's own recovery fails", async () => {
        // Both halves fail at once, which is the realistic pairing: the panel went away, so the
        // write fails AND the reseed that answers it cannot post. If that rejection escapes, the
        // queue promise itself is left rejected and `.then` skips every later keystroke for good.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const adopted = tokenNow();

        mocks.applyEdit.mockRejectedValueOnce(new Error("edit failed"));
        mocks.postMessage.mockRejectedValueOnce(new Error("webview is disposed"));
        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "A",
                baseVersion: documentVersion,
                baseReseedToken: adopted,
            },
        });
        await settle();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "B",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(document.getText(), "the queue must survive its own recovery failing").toBe(
            "B" + diskText,
        );
    });

    it("recovers from a payload that threw while being built, not only from a failed post", async () => {
        // The third way a publish fails, after "the post rejected" and "the post resolved
        // `false`": the payload never existed. `buildData` diffs the document, and the LCS pass
        // allocates an `Int32Array` of up to MAX_LCS_CELLS cells — once for the anchor pass and
        // again per gap. An allocation failure throws before `postMessage` is ever reached, so
        // this shape records no post at all and is invisible to any assertion that reads one.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();
        mocks.postMessage.mockClear();

        documentText = "elsewhere();\n";
        documentVersion += 1;
        // The change handler runs synchronously and reads the document itself, to tell its own
        // echo from a foreign write, before it mints the token and queues the render. Arming
        // between the two puts the failure on the render's read rather than that one — the
        // whole point being a token that is minted and then never published.
        mocks.emitDocumentChange(document);
        getTextFailure = new Error("Array buffer allocation failed");
        await settle();

        expect(
            mocks.postMessage,
            "the build threw, so the minted token reached no post at all",
        ).not.toHaveBeenCalled();

        // The webview is still on the token it last saw, so this is its very next keystroke.
        // Unrecovered it is dropped for being stale and republishes nothing — and the
        // keystrokes that would drive the next render are exactly the ones being dropped, so
        // the pane accepts typing and writes nothing from here on, in silence.
        mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "a",
                baseVersion: documentVersion,
                baseReseedToken: initialToken,
            },
        });

        await vi.waitFor(() => {
            expect(mocks.postMessage.mock.calls.length).toBe(1);
        });
        expect(tokenNow(), "and the republished payload carries the minted token").toBe(
            initialToken + 1,
        );
    });

    it("survives the failure handler itself throwing, so the queue is never left rejected", async () => {
        // `logGitOpsWarning` runs first in the failed-edit handler. If it throws, the handler
        // rejects, the stored chain stays rejected, and `.then` skips every later keystroke —
        // the same permanent wedge as a dropped token, reached from the recovery path instead.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const adopted = tokenNow();

        mocks.applyEdit.mockRejectedValueOnce(new Error("edit failed"));
        mocks.logGitOpsWarning.mockImplementationOnce(() => {
            throw new Error("the output channel is gone");
        });
        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "A",
                baseVersion: documentVersion,
                baseReseedToken: adopted,
            },
        });
        await settle();

        await mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "B",
                baseVersion: documentVersion,
                baseReseedToken: tokenNow(),
            },
        });
        await settle();

        expect(
            document.getText(),
            "a throw inside the handler must not outlive the edit that caused it",
        ).toBe("B" + diskText);
    });

    it("treats a post result outside the boolean contract as delivered, not as a drop", async () => {
        // `postMessage` is typed `Thenable<boolean>`, so `=== false` and `!delivered` cannot be
        // told apart by any value the contract permits. They differ only for a host that
        // answers off-contract, and there the choice matters: latching the flag on anything
        // falsy would put a whole-file republish on the wire for every dropped delta from then
        // on, which is the behaviour the republish is gated to avoid.
        const provider = newProvider();
        await provider.open(uri as never, openDescriptor);
        await resolveAndBoot(provider);
        const initialToken = tokenNow();
        mocks.postMessage.mockClear();
        mocks.postMessage.mockResolvedValueOnce(undefined as never);

        documentText = "elsewhere();\n";
        documentVersion += 1;
        mocks.emitDocumentChange(document);
        await settle();

        mocks.sendWebviewMessage({
            type: "editText",
            delta: {
                startOffset: 0,
                endOffset: 0,
                text: "a",
                baseVersion: documentVersion,
                baseReseedToken: initialToken,
            },
        });
        await settle();

        expect(
            mocks.postMessage.mock.calls.length,
            "an off-contract answer is not a reported drop, so nothing is republished",
        ).toBe(1);
    });
});
