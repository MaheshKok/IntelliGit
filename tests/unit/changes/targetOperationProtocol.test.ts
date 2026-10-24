import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createCommitInfoVscodeDouble,
    createFakeExtensionUri,
} from "../../visual/recorder/commitInfoVscodeDouble";

vi.mock("vscode", () => {
    const double = createCommitInfoVscodeDouble();
    for (const [name, value] of [
        ["showWarningMessage", vi.fn().mockResolvedValue(undefined)],
        ["showInformationMessage", vi.fn().mockResolvedValue(undefined)],
        ["showInputBox", vi.fn().mockResolvedValue("protocol shelf")],
    ] as const)
        Object.defineProperty(double.window, name, { value, configurable: true });
    Object.defineProperty(double.workspace, "textDocuments", { value: [] });
    Object.defineProperty(double.workspace, "notebookDocuments", { value: [] });
    Object.defineProperty(double.l10n, "t", {
        value: (message: string, values: Record<string, string> = {}) =>
            message.replace(/\{([^}]+)\}/g, (match, key: string) => values[key] ?? match),
    });
    return double;
});
const api = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
}));
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => api }));

import * as vscode from "vscode";
import { ChangeWorkflowHost } from "../../../src/views/ChangeWorkflowHost";
import { ChangelistStore } from "../../../src/changes/changelistStore";
import { ShelfService } from "../../../src/services/shelfService";
import { ShelfStore } from "../../../src/shelf/store";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import type { useChangelists } from "../../../src/webviews/react/commit-panel/hooks/useChangelists";
import type { CommitTabProps } from "../../../src/webviews/react/commit-panel/components/CommitTabController";
import type { ChangelistState } from "../../../src/webviews/protocol/changeSelection";
import type { ChangelistReply } from "../../../src/webviews/protocol/changelists";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

type ShelfResult = Extract<ChangelistReply, { type: "changelistShelfResult" }>;

describe("host: one terminal result per request id", () => {
    let root: string;
    let host: ChangeWorkflowHost;
    let shelves: ShelfStore;
    let store: ChangelistStore;
    let posted: unknown[];
    const results = (requestId: string) =>
        posted.filter(
            (message): message is ShelfResult =>
                (message as ShelfResult).type === "changelistShelfResult" &&
                (message as ShelfResult).requestId === requestId,
        );
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const save = (requestId: string, overrides: Record<string, unknown> = {}) => ({
        type: "saveChangelistShelf",
        repositoryRoot: root,
        requestId,
        revision: store.revision(root),
        scope: "files",
        listId: "all",
        paths: ["file.txt"],
        ...overrides,
    });

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), "intelligit-target-protocol-"));
        git(["init", "-q"]);
        git(["config", "user.name", "Protocol"]);
        git(["config", "user.email", "protocol@example.invalid"]);
        git(["config", "commit.gpgSign", "false"]);
        await writeFile(path.join(root, "file.txt"), "base\n");
        git(["add", "--", "file.txt"]);
        git(["commit", "-qm", "base"]);
        await writeFile(path.join(root, "file.txt"), "base\nworking\n");
        const gitOps = new GitOps(new GitExecutor(root));
        const values = new Map<string, unknown>();
        const storage = {
            get: <T>(key: string) => values.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {
                values.set(key, structuredClone(value));
            },
        };
        store = ChangelistStore.forStorage(storage);
        shelves = new ShelfStore(
            await resolveShelfPaths({
                repositoryRoot: root,
                globalStoragePath: path.join(root, "shelf-storage"),
            }),
        );
        const files = await gitOps.getStatus({ withStats: false });
        posted = [];
        host = new ChangeWorkflowHost({
            root,
            extensionUri: createFakeExtensionUri(),
            gitOps,
            workspaceState: storage,
            files: () => files,
            post: (message) => posted.push(message),
            actions: {
                gitOps,
                refreshData: async () => undefined,
                postCommitted: () => undefined,
                fireWorkingTreeChanged: () => undefined,
                maybeOfferPublishBranch: async () => undefined,
            },
            postScopedCommit: () => undefined,
            runCommit: (operation) => operation(),
            shelfService: new ShelfService({
                repositoryRoot: root,
                executor: new GitExecutor(root),
                gitOps,
                changelists: store,
                store: shelves,
                gate: new RepositoryMutationGate(
                    new RepositoryMutationCoordinator(),
                    new RepositoryLock(),
                ),
            }),
        });
        await host.reconcile(files);
        vi.mocked(vscode.window.showInputBox).mockClear().mockResolvedValue("protocol shelf");
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        host.dispose();
        await removeScratchDirectories(root);
    });

    it("repeated request id returns the recorded result and never runs Git again", async () => {
        await host.handle(save("repeat"));
        const [first] = results("repeat");
        expect(first?.shelfId, "first request publishes a shelf").toEqual(expect.any(String));
        const gitRuns = vi.spyOn(GitExecutor.prototype, "runBinary");
        await host.handle(save("repeat"));
        expect(results("repeat"), "duplicate replays the recorded terminal result").toEqual([
            first,
            first,
        ]);
        expect(gitRuns, "duplicate request id must not invoke Git").not.toHaveBeenCalled();
        expect(
            vscode.window.showInputBox,
            "duplicate never reopens the name prompt",
        ).toBeCalledTimes(1);
        expect((await shelves.listShelves()).shelfIds).toEqual([first!.shelfId]);
    });

    it("request id reused for a different captured intent is stale and runs nothing", async () => {
        await host.handle(save("reused"));
        const gitRuns = vi.spyOn(GitExecutor.prototype, "runBinary");
        await host.handle(save("reused", { revision: store.revision(root) + 1 }));
        const [, stale] = results("reused");
        expect(stale?.error, "different revision under the same id is stale").toMatch(/stale/i);
        expect(stale?.shelfId).toBeUndefined();
        expect(gitRuns, "stale request must not invoke Git").not.toHaveBeenCalled();
        expect((await shelves.listShelves()).shelfIds).toHaveLength(1);
    });

    it("duplicate while the first request is outstanding is stale and runs no Git", async () => {
        let finish!: (name: string | undefined) => void;
        let opened!: () => void;
        const prompting = new Promise<void>((resolve) => (opened = resolve));
        vi.mocked(vscode.window.showInputBox).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                    opened();
                }),
        );
        const outstanding = host.handle(save("outstanding"));
        await prompting;
        const gitRuns = vi.spyOn(GitExecutor.prototype, "runBinary");
        await host.handle(save("outstanding"));
        expect(results("outstanding"), "in-flight duplicate gets one stale reply").toEqual([
            expect.objectContaining({ error: expect.stringMatching(/in progress or stale/) }),
        ]);
        expect(gitRuns, "in-flight duplicate must not invoke Git").not.toHaveBeenCalled();
        finish(undefined);
        await outstanding;
        expect(results("outstanding")[1], "cancelled original still terminates").toEqual(
            expect.objectContaining({ message: "Save cancelled." }),
        );
        expect(results("outstanding")[1]?.error).toBeUndefined();
        expect((await shelves.listShelves()).shelfIds).toEqual([]);
    });

    it("cancelled request is terminal: replaying it neither prompts nor saves", async () => {
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);
        await host.handle(save("cancelled"));
        await host.handle(save("cancelled"));
        expect(results("cancelled")).toEqual([
            expect.objectContaining({ message: "Save cancelled." }),
            expect.objectContaining({ message: "Save cancelled." }),
        ]);
        expect(vscode.window.showInputBox).toBeCalledTimes(1);
        expect((await shelves.listShelves()).shelfIds).toEqual([]);
    });

    it.each([
        ["missing request id", { requestId: undefined }],
        ["empty request id", { requestId: "" }],
    ])(
        "validator answers %s with a root-bound error before any prompt or Git",
        async (_name, overrides) => {
            const gitRuns = vi.spyOn(GitExecutor.prototype, "runBinary");
            await host.handle(save("invalid", overrides));
            expect(gitRuns, "invalid request must not invoke Git").not.toHaveBeenCalled();
            expect(vscode.window.showInputBox).not.toHaveBeenCalled();
            expect(posted, "invalid request gets an error, never a shelf result").toContainEqual({
                type: "error",
                repositoryRoot: root,
                message: expect.stringMatching(/requestId/),
            });
            expect(
                posted.filter((m) => (m as ShelfResult).type === "changelistShelfResult"),
            ).toEqual([]);
        },
    );

    it("validator rejects a foreign repository before any prompt or Git", async () => {
        const gitRuns = vi.spyOn(GitExecutor.prototype, "runBinary");
        await expect(
            host.handle(save("invalid", { repositoryRoot: "/elsewhere" })),
        ).rejects.toThrow(/repository/);
        expect(gitRuns).not.toHaveBeenCalled();
        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(posted.filter((m) => (m as ShelfResult).type === "changelistShelfResult")).toEqual(
            [],
        );
    });
});

describe("renderer: replies bind to the captured root and request", () => {
    // The host half needs Node's `vscode` mock, which Vite cannot resolve under the jsdom
    // environment, so the webview half gets its own DOM before React loads.
    let dom: JSDOM;
    let hook: typeof useChangelists;
    let createRoot: typeof import("react-dom/client").createRoot;
    beforeAll(async () => {
        dom = new JSDOM("<!doctype html><body></body>", { url: "https://webview.invalid/" });
        for (const key of [
            "window",
            "document",
            "navigator",
            "HTMLElement",
            "IS_REACT_ACT_ENVIRONMENT",
        ])
            Object.defineProperty(globalThis, key, {
                value:
                    key === "window"
                        ? dom.window
                        : key === "IS_REACT_ACT_ENVIRONMENT"
                          ? true
                          : dom.window[key as "document"],
                configurable: true,
                writable: true,
            });
        ({ createRoot } = await import("react-dom/client"));
        ({ useChangelists: hook } =
            await import("../../../src/webviews/react/commit-panel/hooks/useChangelists"));
    });
    afterAll(() => dom.window.close());
    const mount = (element: React.ReactElement) => {
        const container = dom.window.document.createElement("div");
        const root = createRoot(container);
        act(() => root.render(element));
        return { root };
    };
    const unmount = (root: Root) => act(() => root.unmount());
    let workflow: ReturnType<typeof useChangelists>;
    const state = (revision = 1): ChangelistState => ({
        revision,
        activeId: "default",
        lists: [{ id: "default", name: "Changes", draft: "" }],
        files: {},
        changes: {},
    });
    const props = (repositoryRoot: string) =>
        ({
            repositoryRoot,
            files: [{ path: "file.txt", status: "M", staged: false }],
            checkedPaths: new Set(["file.txt"]),
            commitMessage: "",
            isAmend: false,
        }) as unknown as CommitTabProps;
    function Harness({ root }: { root: string }) {
        workflow = hook(props(root));
        return null;
    }
    const receive = (data: unknown) =>
        act(() => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data })));
    const reply = (repositoryRoot: string, requestId: string): ShelfResult => ({
        type: "changelistShelfResult",
        repositoryRoot,
        requestId,
        message: "Saved shelf.",
        shelfId: "shelf-1",
    });
    let mounted: ReturnType<typeof mount> | undefined;
    const startSave = (root: string) => {
        receive({ type: "setChangelists", repositoryRoot: root, state: state() });
        act(() => workflow.saveShelf("list", "default"));
        const sent = api.postMessage.mock.calls
            .map(([message]) => message as { type: string; requestId?: string })
            .filter((message) => message.type === "saveChangelistShelf");
        return sent.at(-1)!;
    };
    beforeEach(() => {
        api.postMessage.mockClear();
        mounted = mount(React.createElement(Harness, { root: "/one" }));
    });
    afterEach(() => {
        if (mounted) unmount(mounted.root);
        mounted = undefined;
    });

    it("sends request id with captured root and revision", () => {
        const sent = startSave("/one");
        expect(sent).toEqual(
            expect.objectContaining({
                repositoryRoot: "/one",
                revision: 1,
                requestId: expect.stringMatching(/\S/),
            }),
        );
        expect(workflow.busy).toBe(true);
    });

    it("ignores a reply for a replaced request id", () => {
        startSave("/one");
        receive(reply("/one", "older-request"));
        expect(workflow.busy, "foreign request id leaves the save outstanding").toBe(true);
        expect(workflow.notice).toBeUndefined();
    });

    it("ignores a reply for a different repository with the same request id", () => {
        const sent = startSave("/one");
        receive(reply("/two", sent.requestId!));
        expect(workflow.busy, "other repository reply leaves the save outstanding").toBe(true);
        expect(workflow.notice).toBeUndefined();
        receive(reply("/one", sent.requestId!));
        expect(workflow.busy).toBe(false);
        expect(workflow.notice, "matching root and request id completes").toBe("Saved shelf.");
    });

    it("drops a late reply after the panel switches repository", () => {
        const sent = startSave("/one");
        act(() => mounted!.root.render(React.createElement(Harness, { root: "/two" })));
        receive({ type: "setChangelists", repositoryRoot: "/two", state: state(5) });
        receive(reply("/one", sent.requestId!));
        receive(reply("/two", sent.requestId!));
        expect(workflow.notice, "old repository request never completes the new panel").toBe(
            undefined,
        );
        expect(workflow.error).toBeUndefined();
    });

    it("disposed panel stops listening for replies", () => {
        const added = vi.spyOn(dom.window, "addEventListener");
        act(() => mounted!.root.render(React.createElement(Harness, { root: "/three" })));
        const listener = added.mock.calls.find(([type]) => type === "message")?.[1];
        const removed = vi.spyOn(dom.window, "removeEventListener");
        unmount(mounted!.root);
        mounted = undefined;
        expect(listener, "panel subscribed to replies").toBeDefined();
        expect(
            removed.mock.calls.filter(([type, fn]) => type === "message" && fn === listener),
            "disposed panel removes its own reply listener",
        ).toHaveLength(1);
    });
});
