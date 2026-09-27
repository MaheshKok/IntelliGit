import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";
import { GitExecutor } from "../../../src/git/executor";

const HEAD = "1234567890abcdef1234567890abcdef12345678";
const mocks = vi.hoisted(() => {
    class Uri {
        constructor(
            readonly fsPath: string,
            readonly scheme = "file",
        ) {}
    }
    return {
        Uri,
        activeUri: new Uri("/repo-a/active.txt"),
        realpath: vi.fn(async (value: string) => value),
        discover: vi.fn(async () => "/repo-b\n"),
        run: vi.fn(async (args: string[]) =>
            args[0] === "rev-parse" ? "1234567890abcdef1234567890abcdef12345678\n" : "",
        ),
        deriveExecutor: vi.fn(),
        operation: vi.fn(async () => "none"),
        input: vi.fn(async () => "v1.0.0" as string | undefined),
        error: vi.fn(),
        info: vi.fn(),
    };
});

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath }));
vi.mock("vscode", () => ({
    Uri: mocks.Uri,
    window: {
        get activeTextEditor() {
            return { document: { uri: mocks.activeUri } };
        },
        showInputBox: mocks.input,
        showErrorMessage: mocks.error,
        showInformationMessage: mocks.info,
    },
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            Object.entries(args ?? {}).reduce(
                (text, [key, value]) => text.replace(`{${key}}`, String(value)),
                message,
            ),
    },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.discover;
        deriveFor = mocks.deriveExecutor;
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({ showTimedInformationMessage: mocks.info }));

import * as commands from "../../../src/commands/fileContextCommands";

const handler = (
    commands as typeof commands & {
        newTagFileFromContext: (
            ctx: unknown,
            gitOps: GitOps,
            executor: GitExecutor,
            refresh: (repoRoot: string) => Promise<void>,
        ) => Promise<void>;
    }
).newTagFileFromContext;
const scoped = { getActiveOperation: mocks.operation } as unknown as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = { deriveFor } as unknown as GitOps;
const executor = new GitExecutor("/repo-a");
const refresh = vi.fn(async (_repoRoot: string) => undefined);

beforeEach(() => {
    vi.clearAllMocks();
    deriveFor.mockImplementation(() => scoped);
    mocks.deriveExecutor.mockReturnValue({ run: mocks.run });
    mocks.activeUri = new mocks.Uri("/repo-a/active.txt");
    mocks.discover.mockResolvedValue("/repo-b\n");
    mocks.operation.mockResolvedValue("none");
    mocks.input.mockResolvedValue("v1.0.0");
    mocks.run.mockImplementation(async (args) => (args[0] === "rev-parse" ? `${HEAD}\n` : ""));
    refresh.mockResolvedValue(undefined);
});

describe("native New Tag repository contract", () => {
    it("contributes New Tag after New Branch in both native file submenus", () => {
        const manifest = JSON.parse(
            readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
        );
        expect(manifest.contributes.commands).toContainEqual({
            command: "intelligit.fileNewTag",
            title: "%command.fileNewTag%",
            category: "%intelligit%",
        });
        for (const menu of ["intelligit.fileContext", "intelligit.editorContext"]) {
            const entries = manifest.contributes.menus[menu];
            const branch = entries.findIndex(
                (entry: { command?: string }) => entry.command === "intelligit.fileNewBranch",
            );
            expect(entries[branch + 1], `${menu} puts New Tag after New Branch`).toEqual({
                command: "intelligit.fileNewTag",
                when: "resourceScheme == file",
                group: "4_branch@5",
            });
        }
        expect(manifest.contributes.menus["explorer/context"]).toContainEqual(
            expect.objectContaining({ submenu: "intelligit.fileContext" }),
        );
        expect(manifest.contributes.menus["editor/title/context"]).toContainEqual(
            expect.objectContaining({ submenu: "intelligit.fileContext" }),
        );
        expect(manifest.contributes.menus["editor/context"]).toContainEqual(
            expect.objectContaining({ submenu: "intelligit.editorContext" }),
        );
    });
    it("exposes the scoped native handler", () => {
        expect(handler, "New Tag handler must be registered for file context").toBeTypeOf(
            "function",
        );
    });

    it("explicitly disables signing for a lightweight tag at clicked B's captured pre-prompt HEAD", async () => {
        await handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
        expect(deriveFor, "clicked B owns both operation fences").toHaveBeenCalledWith("/repo-b");
        expect(mocks.deriveExecutor, "clicked B owns HEAD and tag").toHaveBeenCalledExactlyOnceWith(
            "/repo-b",
        );
        expect(mocks.run.mock.calls.map(([args]) => args)).toEqual([
            ["rev-parse", "HEAD"],
            ["tag", "--no-sign", "v1.0.0", HEAD],
        ]);
        expect(mocks.input).toHaveBeenCalledWith({
            prompt: "New tag at 1234567",
            placeHolder: "v1.0.0",
        });
        expect(mocks.operation).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(mocks.info).toHaveBeenCalledWith("Created tag v1.0.0.");
    });

    it("retains clicked B and its original hash when active repository and HEAD drift during input", async () => {
        let release!: (value: string) => void;
        const cRun = vi.fn(async (_args: string[]) => "");
        const cOperation = vi.fn(async () => "none");
        mocks.input.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
        await vi.waitFor(() => expect(mocks.input).toHaveBeenCalledOnce());
        mocks.activeUri = new mocks.Uri("/repo-c/other.txt");
        mocks.discover.mockResolvedValue("/repo-c\n");
        mocks.deriveExecutor.mockImplementation((root: string) =>
            root === "/repo-c" ? { run: cRun } : { run: mocks.run },
        );
        deriveFor.mockImplementation((root: string) =>
            root === "/repo-c" ? ({ getActiveOperation: cOperation } as unknown as GitOps) : scoped,
        );
        mocks.run.mockResolvedValue(`${"f".repeat(40)}\n`);
        release("drift-safe");
        await pending;
        expect(
            deriveFor,
            "B's Git facade stays captured across input",
        ).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(
            mocks.deriveExecutor,
            "B's executor stays captured across input",
        ).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(cOperation).not.toHaveBeenCalled();
        expect(cRun, "active C never receives a Git command").not.toHaveBeenCalled();
        expect(mocks.run.mock.calls.map(([args]) => args)).toEqual([
            ["rev-parse", "HEAD"],
            ["tag", "--no-sign", "drift-safe", HEAD],
        ]);
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it.each([undefined, "", "-bad"])(
        "rejects cancelled, empty, or invalid input %s without mutation",
        async (name) => {
            mocks.input.mockResolvedValueOnce(name);
            await handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
            expect(mocks.run.mock.calls.map(([args]) => args)).toEqual([["rev-parse", "HEAD"]]);
            expect(refresh).not.toHaveBeenCalled();
            expect(mocks.info).not.toHaveBeenCalled();
            if (name === "-bad")
                expect(mocks.error).toHaveBeenCalledWith(
                    expect.stringContaining("Invalid tag name '-bad'"),
                );
        },
    );

    it("does not prompt or tag when HEAD cannot be resolved", async () => {
        mocks.run.mockRejectedValueOnce(new Error("HEAD missing"));
        await handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
        expect(mocks.input).not.toHaveBeenCalled();
        expect(mocks.run).toHaveBeenCalledExactlyOnceWith(["rev-parse", "HEAD"]);
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("HEAD missing"));
        expect(refresh).not.toHaveBeenCalled();
    });

    it.each(["first", "second"])("honors the %s operation fence", async (stage) => {
        if (stage === "first") mocks.operation.mockResolvedValueOnce("merge");
        else mocks.operation.mockResolvedValueOnce("none").mockResolvedValueOnce("merge");
        await handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
        expect(mocks.run.mock.calls.map(([args]) => args)).toEqual(
            stage === "first" ? [] : [["rev-parse", "HEAD"]],
        );
        if (stage === "first") expect(mocks.input).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it.each(["busy", "disposed"])("%s while prompt open prevents tagging", async (state) => {
        let release!: (value: string) => void;
        let operation: "none" | "merge" = "none";
        let disposed = false;
        mocks.operation.mockImplementation(async () => {
            if (disposed) throw new Error("repository disposed");
            return operation;
        });
        mocks.input.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const pending = handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
        await vi.waitFor(() => expect(mocks.input).toHaveBeenCalledOnce());
        if (state === "disposed") disposed = true;
        else operation = "merge";
        release("v2.0.0");
        await pending;
        expect(
            mocks.run.mock.calls.map(([args]) => args),
            "prompt-time state blocks tag mutation",
        ).toEqual([["rev-parse", "HEAD"]]);
        expect(mocks.info).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalled();
    });

    it.each(["first", "second"])(
        "fails closed when the %s operation probe rejects",
        async (stage) => {
            if (stage === "first") mocks.operation.mockRejectedValueOnce(new Error("disposed"));
            else
                mocks.operation
                    .mockResolvedValueOnce("none")
                    .mockRejectedValueOnce(new Error("disposed"));
            await handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
            expect(mocks.run.mock.calls.map(([args]) => args)).toEqual(
                stage === "first" ? [] : [["rev-parse", "HEAD"]],
            );
            if (stage === "first") expect(mocks.input).not.toHaveBeenCalled();
            expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("Unable to check"));
            expect(mocks.info).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
        },
    );

    it("surfaces duplicate Git rejection without success and refreshes captured B", async () => {
        mocks.run.mockImplementation(async (args) => {
            if (args[0] === "rev-parse") return `${HEAD}\n`;
            throw new Error("tag 'v1.0.0' already exists");
        });
        await handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
        expect(mocks.run).toHaveBeenLastCalledWith(["tag", "--no-sign", "v1.0.0", HEAD]);
        expect(mocks.error).toHaveBeenCalledWith(
            "Failed to create tag: tag 'v1.0.0' already exists",
        );
        expect(mocks.info).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it("reports refresh failure without falsely reporting that tag creation failed", async () => {
        refresh.mockRejectedValueOnce(new Error("panels unavailable"));
        await handler(new mocks.Uri("/repo-b/selected.txt"), gitOps, executor, refresh);
        expect(mocks.info).toHaveBeenCalledWith("Created tag v1.0.0.");
        expect(mocks.error).toHaveBeenCalledWith(
            "Tag views could not be refreshed: panels unavailable",
        );
        expect(mocks.error).not.toHaveBeenCalledWith(
            expect.stringContaining("Failed to create tag"),
        );
    });

    it("rejects non-file context without falling back to active A", async () => {
        await handler(new mocks.Uri("/repo-b/selected.txt", "git"), gitOps, executor, refresh);
        expect(deriveFor).not.toHaveBeenCalled();
        expect(mocks.run).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith("New Tag is only available for local files.");
    });
});
