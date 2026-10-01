import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const mocks = vi.hoisted(() => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const listener = (name: string) => (callback: (...args: any[]) => void) => {
        listeners.set(name, callback);
        return { dispose: vi.fn() };
    };
    return {
        listeners,
        listener,
        visibleEditors: [] as any[],
        showTextDocument: vi.fn(),
        showErrorMessage: vi.fn(),
        decoration: { dispose: vi.fn() },
        createDecoration: vi.fn(),
        runBinary: vi.fn(),
        roots: [] as string[],
        subscriptions: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
    };
});

vi.mock("vscode", () => ({
    window: {
        createTextEditorDecorationType: mocks.createDecoration,
        showTextDocument: mocks.showTextDocument,
        showErrorMessage: mocks.showErrorMessage,
        get visibleTextEditors() {
            return mocks.visibleEditors;
        },
        onDidChangeVisibleTextEditors: mocks.listener("visible"),
    },
    workspace: {
        onDidChangeTextDocument: mocks.listener("change"),
        onDidSaveTextDocument: mocks.listener("save"),
        onDidCloseTextDocument: mocks.listener("close"),
    },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    ThemeColor: class {
        constructor(readonly id: string) {}
    },
    Range: class {
        constructor(
            readonly startLine: number,
            readonly startCharacter: number,
            readonly endLine: number,
            readonly endCharacter: number,
        ) {}
    },
    MarkdownString: class {
        value = "";
        appendText(text: string) {
            this.value += text.replace(/[\\`*_{}\[\]()#+.!-]/g, "\\$&");
            return this;
        }
        appendMarkdown(text: string) {
            this.value += text;
            return this;
        }
    },
    l10n: {
        t: (text: string, args?: Record<string, string>) =>
            Object.entries(args ?? {}).reduce(
                (result, [key, value]) => result.replace(`{${key}}`, value),
                text,
            ),
    },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        constructor(root: string) {
            mocks.roots.push(root);
        }
        runBinary = mocks.runBinary;
    },
}));
vi.mock("../../../src/services/repositoryChangeEvents", () => ({
    subscribeToRepositoryWorkingTreeChanges: (
        _root: string,
        callback: (...args: any[]) => void,
    ) => {
        mocks.listeners.set("repository", callback);
        const subscription = { dispose: vi.fn() };
        mocks.subscriptions.push(subscription);
        return subscription;
    },
}));

import {
    FileBlameAnnotations,
    getFileBlameAnnotations,
} from "../../../src/services/fileBlameAnnotations";

const commit = "a".repeat(40);
const output = (hash = commit, line = 1) =>
    `${hash} ${line} ${line} 1\nauthor Ada\nauthor-time 946684800\nauthor-tz +0000\nsummary Fix [bad](command:bad)\nfilename source.ts\n\tsource\n`;
const result = (stdout = output(), truncated = false) => ({
    stdout: Buffer.from(stdout),
    truncated,
});
const uri = { toString: () => "file:/repo/source.ts" } as vscode.Uri;
const target = { selectedUri: uri, repoRoot: "/repo", repoRelativePath: "source.ts" };
let text: string;
let document: vscode.TextDocument;
let editor: any;
let service: FileBlameAnnotations;

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.roots.length = 0;
    mocks.subscriptions.length = 0;
    text = "source\n";
    document = { uri, version: 1, lineCount: 2, getText: () => text } as vscode.TextDocument;
    editor = { document, setDecorations: vi.fn() };
    mocks.visibleEditors = [editor];
    mocks.showTextDocument.mockResolvedValue(editor);
    mocks.createDecoration.mockReturnValue(mocks.decoration);
    mocks.runBinary.mockReset().mockResolvedValue(result());
    service = new FileBlameAnnotations();
});

afterEach(() => {
    service.dispose();
    vi.useRealTimers();
});

const latest = () => editor.setDecorations.mock.calls.at(-1)[1];
const change = () => {
    (document as { version: number }).version += 1;
    mocks.listeners.get("change")?.({ document, contentChanges: [{}] });
};

describe("FileBlameAnnotations", () => {
    it("decorates the editable source with a fixed-width before attachment and escaped hover", async () => {
        await service.toggle(target);
        expect(mocks.roots).toEqual(["/repo"]);
        expect(mocks.runBinary).toHaveBeenCalledWith(
            ["blame", "--porcelain", "--contents", "-", "--", "source.ts"],
            {
                input: Buffer.from(text),
                maxOutputBytes: 4 * 1024 * 1024,
                signal: expect.any(AbortSignal),
            },
        );
        expect(mocks.showTextDocument).toHaveBeenCalledWith(uri, { preview: false });
        expect(mocks.createDecoration).toHaveBeenCalledWith(
            expect.objectContaining({ before: expect.objectContaining({ width: "38ch" }) }),
        );
        expect(latest()[0].renderOptions.before.contentText).toBe("aaaaaaaa 2000-01-01 Ada");
        expect(latest()[0].hoverMessage.value).toContain("\\[bad\\]\\(command:bad\\)");
        expect(latest()[0].hoverMessage.isTrusted).toBeUndefined();
    });

    it("toggles off without opening a replacement document or leaving a subscription", async () => {
        await service.toggle(target);
        await service.toggle(target);
        expect(latest()).toEqual([]);
        expect(mocks.showTextDocument).toHaveBeenCalledTimes(1);
        expect(mocks.subscriptions[0].dispose).toHaveBeenCalledOnce();
    });

    it("escapes backslashes and Markdown punctuation in hover metadata", async () => {
        mocks.runBinary.mockResolvedValue(
            result(
                output().replace(
                    "Fix [bad](command:bad)",
                    String.raw`Fix \[bad](command:bad) *bold*`,
                ),
            ),
        );
        await service.toggle(target);
        expect(latest()[0].hoverMessage.value).toContain(
            String.raw`Fix \\\[bad\]\(command:bad\) \*bold\*`,
        );
    });

    it("renders repeated commit metadata from compact porcelain records", async () => {
        mocks.runBinary.mockResolvedValue(result(output() + `${commit} 2 2\n\t\n`));
        await service.toggle(target);
        expect(latest()).toHaveLength(2);
        expect(latest()[1].renderOptions.before.contentText).toBe("aaaaaaaa 2000-01-01 Ada");
        expect(latest()[1].hoverMessage.value).toBe(latest()[0].hoverMessage.value);
    });

    it.each(["Not Committed Yet", "External file (--contents)"])(
        "refreshes unsaved contents and labels zero-hash lines regardless of Git's author: %s",
        async (author) => {
            await service.toggle(target);
            text = "unsaved\n";
            mocks.runBinary.mockResolvedValue(
                result(output("0".repeat(40)).replace("author Ada", `author ${author}`)),
            );
            change();
            expect(latest()).toEqual([]);
            await vi.advanceTimersByTimeAsync(300);
            expect(mocks.runBinary.mock.calls.at(-1)[1].input.toString()).toBe(text);
            expect(latest()[0].renderOptions.before.contentText).toContain("Uncommitted changes");
            expect(latest()[0].hoverMessage.value).toBe("Uncommitted changes");
        },
    );

    it("accepts an empty editor buffer without falling back to disk", async () => {
        text = "";
        mocks.runBinary.mockResolvedValue(result(""));
        await service.toggle(target);
        expect(mocks.runBinary.mock.calls[0][1].input).toEqual(Buffer.alloc(0));
        expect(latest()).toEqual([]);
    });

    it("discards in-flight results and reads the new version without overlapping Git processes", async () => {
        let resolve!: (value: ReturnType<typeof result>) => void;
        mocks.runBinary.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const toggling = service.toggle(target);
        await Promise.resolve();
        text = "new\n";
        change();
        await vi.advanceTimersByTimeAsync(300);
        expect(mocks.runBinary).toHaveBeenCalledTimes(1);
        resolve(result());
        await toggling;
        expect(mocks.runBinary).toHaveBeenCalledTimes(2);
        expect(mocks.runBinary.mock.calls[1][1].input.toString()).toBe(text);
    });

    it("does not resurrect annotations if toggled off while Git is running", async () => {
        let resolve!: (value: ReturnType<typeof result>) => void;
        mocks.runBinary.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const toggling = service.toggle(target);
        await Promise.resolve();
        await service.toggle(target);
        resolve(result());
        await toggling;
        expect(latest()).toEqual([]);
    });

    it("reapplies annotations to a split editor and ignores unrelated repository files", async () => {
        await service.toggle(target);
        const split = { document, setDecorations: vi.fn() };
        mocks.visibleEditors.push(split);
        mocks.listeners.get("visible")?.();
        expect(split.setDecorations).toHaveBeenCalledWith(mocks.decoration, latest());
        mocks.listeners.get("repository")?.({ source: "workspace-file", path: "other.ts" });
        await vi.advanceTimersByTimeAsync(300);
        expect(mocks.runBinary).toHaveBeenCalledTimes(1);
        mocks.listeners.get("repository")?.({ source: "git-refs" });
        await vi.advanceTimersByTimeAsync(300);
        expect(mocks.runBinary).toHaveBeenCalledTimes(2);
    });

    it("clears annotations from a split editor that is temporarily hidden", async () => {
        await service.toggle(target);
        const split = { document, setDecorations: vi.fn() };
        mocks.visibleEditors.push(split);
        mocks.listeners.get("visible")?.();
        mocks.visibleEditors = [editor];
        mocks.listeners.get("visible")?.();
        await service.toggle(target);
        expect(split.setDecorations).toHaveBeenLastCalledWith(mocks.decoration, []);
    });

    it("refreshes on save and cleans up on document close", async () => {
        await service.toggle(target);
        mocks.listeners.get("save")?.(document);
        await vi.advanceTimersByTimeAsync(300);
        expect(mocks.runBinary).toHaveBeenCalledTimes(2);
        mocks.listeners.get("close")?.(document);
        expect(latest()).toEqual([]);
        expect(mocks.subscriptions[0].dispose).toHaveBeenCalledOnce();
    });

    it("rejects truncated output and removes the failed session", async () => {
        mocks.runBinary.mockResolvedValue(result("partial", true));
        await expect(service.toggle(target)).rejects.toThrow("maximum 4 MiB");
        expect(latest()).toEqual([]);
        expect(mocks.subscriptions[0].dispose).toHaveBeenCalledOnce();
    });

    it.each(["binary\0data", "x".repeat(4 * 1024 * 1024 + 1)])(
        "rejects non-text or oversized buffers before running Git",
        async (value) => {
            text = value;
            await expect(service.toggle(target)).rejects.toThrow();
            expect(mocks.runBinary).not.toHaveBeenCalled();
        },
    );

    it("reports background failures and clears stale decorations", async () => {
        await service.toggle(target);
        mocks.runBinary.mockRejectedValueOnce(new Error("missing HEAD"));
        change();
        await vi.advanceTimersByTimeAsync(300);
        expect(latest()).toEqual([]);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Annotate with Git Blame failed: missing HEAD",
        );
    });

    it.each(["toggle", "close", "dispose"])(
        "cancels an in-flight Git read on %s without reporting a user error",
        async (action) => {
            let signal!: AbortSignal;
            mocks.runBinary.mockImplementationOnce(
                (_args, options) =>
                    new Promise((_resolve, reject) => {
                        signal = options.signal;
                        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                            once: true,
                        });
                    }),
            );
            const toggling = service.toggle(target);
            await Promise.resolve();
            if (action === "toggle") await service.toggle(target);
            else if (action === "close") mocks.listeners.get("close")?.(document);
            else service.dispose();
            await expect(toggling).resolves.toBeUndefined();
            expect(signal.aborted).toBe(true);
            expect(latest()).toEqual([]);
            expect(mocks.subscriptions[0].dispose).toHaveBeenCalledOnce();
            expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        },
    );

    it("starts a replacement session with a fresh signal after cancelling the old read", async () => {
        mocks.runBinary.mockImplementationOnce(
            (_args, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                        once: true,
                    });
                }),
        );
        const first = service.toggle(target);
        await Promise.resolve();
        await service.toggle(target);
        await service.toggle(target);
        await first;
        expect(mocks.runBinary.mock.calls[0][1].signal.aborted).toBe(true);
        expect(mocks.runBinary.mock.calls[1][1].signal.aborted).toBe(false);
        expect(latest()[0].renderOptions.before.contentText).toContain("Ada");
    });

    it("cancels background reads and pending refresh timers when annotations are disabled", async () => {
        await service.toggle(target);
        mocks.runBinary.mockImplementationOnce(
            (_args, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                        once: true,
                    });
                }),
        );
        change();
        await vi.advanceTimersByTimeAsync(300);
        change();
        await service.toggle(target);
        await vi.advanceTimersByTimeAsync(300);
        expect(mocks.runBinary).toHaveBeenCalledTimes(2);
        expect(mocks.runBinary.mock.calls[1][1].signal.aborted).toBe(true);
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    });

    it("owns one lazy service per activation and releases its decoration", () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const lazy = getFileBlameAnnotations(context);
        expect(getFileBlameAnnotations(context)).toBe(lazy);
        expect(context.subscriptions).toEqual([lazy]);
        lazy.dispose();
        expect(mocks.decoration.dispose).toHaveBeenCalled();
    });
});
