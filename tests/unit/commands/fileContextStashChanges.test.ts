import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOps } from "../../../src/git/operations";

const mocks = vi.hoisted(() => {
    class Uri {
        constructor(
            readonly fsPath: string,
            readonly scheme = "file",
        ) {}
    }
    return {
        Uri,
        activeUri: new Uri("/repo-a/active.txt") as Uri | undefined,
        realpath: vi.fn(async (value: string) => value),
        discover: vi.fn(async () => "/repo-b\n"),
        operation: vi.fn(async () => "none"),
        stash: vi.fn(async () => "Saved working directory and index state"),
        input: vi.fn(async () => "Stashed changes" as string | undefined),
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
                (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
                message,
            ),
    },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.discover;
    },
}));
vi.mock("../../../src/services/diffService", () => ({}));
vi.mock("../../../src/utils/notifications", () => ({ showTimedInformationMessage: mocks.info }));

import { stashChangesFromContext } from "../../../src/commands/fileContextCommands";

const scoped = {
    getActiveOperation: mocks.operation,
    stashSave: mocks.stash,
} as unknown as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = { deriveFor, stashSave: vi.fn() } as unknown as GitOps;
const refresh = vi.fn(async (_root: string) => undefined);
const selected = () => new mocks.Uri("/repo-b/selected.txt");

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeUri = new mocks.Uri("/repo-a/active.txt");
    deriveFor.mockReturnValue(scoped);
    mocks.discover.mockResolvedValue("/repo-b\n");
    mocks.operation.mockResolvedValue("none");
    mocks.stash.mockResolvedValue("Saved working directory and index state");
    mocks.input.mockResolvedValue("Stashed changes");
});

describe("native Stash Changes repository contract", () => {
    it("contributes one ellipsis command after Reset HEAD in both native submenus", () => {
        const manifest = JSON.parse(
            readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
        );
        const nls = JSON.parse(
            readFileSync(new URL("../../../package.nls.json", import.meta.url), "utf8"),
        );
        expect(manifest.contributes.commands).toContainEqual({
            command: "intelligit.fileStashChanges",
            title: "%command.fileStashChanges%",
            category: "%intelligit%",
        });
        expect(nls["command.fileStashChanges"]).toBe("Stash Changes…");
        expect(nls["command.stashChanges"]).toBe("Stash Changes");
        for (const menu of ["intelligit.fileContext", "intelligit.editorContext"]) {
            const entries = manifest.contributes.menus[menu];
            const reset = entries.findIndex(
                (entry: { command?: string }) => entry.command === "intelligit.fileResetHead",
            );
            expect(entries[reset + 1], `${menu} places Stash Changes after Reset HEAD`).toEqual({
                command: "intelligit.fileStashChanges",
                when: "resourceScheme == file",
                group: "4_branch@7",
            });
        }
        for (const menu of ["explorer/context", "editor/title/context", "editor/context"]) {
            expect(
                manifest.contributes.menus[menu].some(
                    (entry: { submenu?: string }) =>
                        entry.submenu ===
                        (menu === "editor/context"
                            ? "intelligit.editorContext"
                            : "intelligit.fileContext"),
                ),
            ).toBe(true);
        }
    });

    it("stashes all of clicked B with no path and captures its refresh while A is active", async () => {
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(deriveFor).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(mocks.input).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Stash Changes",
                value: "Stashed changes",
                prompt: expect.stringMatching(/tracked.*untracked.*repo-b/i),
            }),
        );
        expect(
            mocks.stash,
            "whole B repository, not selected file",
        ).toHaveBeenCalledExactlyOnceWith(undefined, "Stashed changes");
        expect(gitOps.stashSave).not.toHaveBeenCalled();
        expect(mocks.operation).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
        expect(mocks.info).toHaveBeenCalledWith("Changes stashed.");
    });

    it("reports a clean repository without claiming a stash was created or refreshing", async () => {
        mocks.stash.mockResolvedValueOnce("No local changes to save\n");

        await stashChangesFromContext(selected(), gitOps, refresh);

        expect(mocks.stash).toHaveBeenCalledExactlyOnceWith(undefined, "Stashed changes");
        expect(mocks.info).toHaveBeenCalledExactlyOnceWith("No local changes to save.");
        expect(refresh).not.toHaveBeenCalled();
    });

    it("reports success when a created stash's message contains the no-change text", async () => {
        mocks.input.mockResolvedValueOnce("No local changes to save");
        mocks.stash.mockResolvedValueOnce(
            "Saved working directory and index state On main: No local changes to save\n",
        );

        await stashChangesFromContext(selected(), gitOps, refresh);

        expect(mocks.stash).toHaveBeenCalledExactlyOnceWith(undefined, "No local changes to save");
        expect(mocks.info).toHaveBeenCalledExactlyOnceWith("Changes stashed.");
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it("keeps B through a prompt-time active-repository change", async () => {
        const alternate = { getActiveOperation: vi.fn(), stashSave: vi.fn() } as unknown as GitOps;
        mocks.input.mockImplementationOnce(async () => {
            deriveFor.mockReturnValue(alternate);
            mocks.activeUri = new mocks.Uri("/repo-a/other.txt");
            return "  literal  ";
        });
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(mocks.operation).toHaveBeenCalledTimes(2);
        expect(mocks.stash).toHaveBeenCalledExactlyOnceWith(undefined, "  literal  ");
        expect(alternate.stashSave).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledExactlyOnceWith("/repo-b");
    });

    it.each(["", "   ", " padded "])("passes confirmed message %j literally", async (message) => {
        mocks.input.mockResolvedValueOnce(message);
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(mocks.stash).toHaveBeenCalledExactlyOnceWith(undefined, message);
    });

    it("cancels only on undefined without mutation or refresh", async () => {
        mocks.input.mockResolvedValueOnce(undefined);
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(mocks.operation).toHaveBeenCalledOnce();
        expect(mocks.stash).not.toHaveBeenCalled();
        expect(mocks.info).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it.each([new mocks.Uri("/repo-b/x", "git"), {}])(
        "rejects invalid explicit URI %j",
        async (uri) => {
            await stashChangesFromContext(uri, gitOps, refresh);
            expect(mocks.stash).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
            expect(mocks.error).toHaveBeenCalledWith(
                "Stash Changes is only available for local files.",
            );
        },
    );

    it("rejects missing URI when there is no active editor", async () => {
        mocks.activeUri = undefined;
        await stashChangesFromContext(undefined, gitOps, refresh);
        expect(mocks.stash).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(
            "Stash Changes is only available for local files.",
        );
    });

    it("reports a file outside a repository without stashing", async () => {
        mocks.discover.mockResolvedValueOnce("/elsewhere\n");
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(mocks.stash).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("outside"));
    });

    it.each(["merge", "rebase", "cherry-pick", "revert", "future-state"])(
        "initial %s guard refuses before prompting",
        async (operation) => {
            mocks.operation.mockResolvedValueOnce(operation);
            await stashChangesFromContext(selected(), gitOps, refresh);
            expect(mocks.input).not.toHaveBeenCalled();
            expect(mocks.stash).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
        },
    );

    it("unreadable initial operation state refuses before prompting", async () => {
        mocks.operation.mockRejectedValueOnce(new Error("probe failed"));
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(mocks.input).not.toHaveBeenCalled();
        expect(mocks.stash).not.toHaveBeenCalled();
    });

    it.each(["merge", "future-state"])(
        "post-prompt %s guard refuses before mutation",
        async (operation) => {
            mocks.operation.mockResolvedValueOnce("none").mockResolvedValueOnce(operation);
            await stashChangesFromContext(selected(), gitOps, refresh);
            expect(mocks.input).toHaveBeenCalledOnce();
            expect(mocks.stash).not.toHaveBeenCalled();
            expect(mocks.info).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
        },
    );

    it("unreadable post-prompt operation state refuses before mutation", async () => {
        mocks.operation
            .mockResolvedValueOnce("none")
            .mockRejectedValueOnce(new Error("probe failed"));
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(mocks.stash).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("reports rejected Git result without success or refresh", async () => {
        mocks.stash.mockRejectedValueOnce(new Error("cannot stash"));
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(mocks.error).toHaveBeenCalledWith("Stash failed: cannot stash");
        expect(mocks.info).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("reports successful stash and refresh failure separately", async () => {
        refresh.mockRejectedValueOnce(new Error("panel unavailable"));
        await stashChangesFromContext(selected(), gitOps, refresh);
        expect(mocks.stash).toHaveBeenCalledExactlyOnceWith(undefined, "Stashed changes");
        expect(mocks.info).toHaveBeenCalledWith("Changes stashed.");
        expect(mocks.error).toHaveBeenCalledWith(
            "Stash succeeded, but refresh failed: panel unavailable",
        );
    });
});
