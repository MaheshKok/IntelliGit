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
        active: new Uri("/repo-a/active.txt"),
        realpath: vi.fn(async (path: string) => path),
        discover: vi.fn(async () => "/repo-b\n"),
        open: vi.fn(),
        error: vi.fn(),
    };
});

vi.mock("node:fs/promises", () => ({ realpath: mocks.realpath }));
vi.mock("vscode", () => ({
    Uri: mocks.Uri,
    window: {
        get activeTextEditor() {
            return { document: { uri: mocks.active } };
        },
        showErrorMessage: mocks.error,
    },
    l10n: { t: (text: string) => text },
}));
vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class {
        run = mocks.discover;
    },
}));
vi.mock("../../../src/views/ManageRemotesPanel", () => ({
    ManageRemotesPanel: { open: mocks.open },
}));
vi.mock("../../../src/services/worktreeService", () => ({ WorktreeService: class {} }));
vi.mock("../../../src/services/diffService", () => ({}));

import { manageRemotesFileFromContext } from "../../../src/commands/fileContextCommands";

const scoped = {} as GitOps;
const deriveFor = vi.fn(() => scoped);
const gitOps = { deriveFor } as unknown as GitOps;
const refresh = vi.fn(async (_root: string) => undefined);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.active = new mocks.Uri("/repo-a/active.txt");
    mocks.discover.mockResolvedValue("/repo-b\n");
});

describe("Manage Remotes clicked-file command", () => {
    it("captures clicked B and its scoped GitOps before active A changes", async () => {
        await manageRemotesFileFromContext(
            new mocks.Uri("/repo-b/file.txt"),
            gitOps,
            {} as never,
            refresh,
        );
        mocks.active = new mocks.Uri("/repo-a/other.txt");
        expect(deriveFor).toHaveBeenCalledWith("/repo-b");
        expect(mocks.open).toHaveBeenCalledWith({}, scoped, "/repo-b", refresh);
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it("rejects non-file contexts before creating a panel", async () => {
        await manageRemotesFileFromContext(
            new mocks.Uri("https://x", "https"),
            gitOps,
            {} as never,
            refresh,
        );
        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalled();
    });
});
