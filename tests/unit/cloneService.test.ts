import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn(),
    executeCommand: vi.fn(),
    updateWorkspaceFolders: vi.fn(),
    getSession: vi.fn(),
    configValues: new Map<string, unknown>(),
    configUpdate: vi.fn(),
    fsAccess: vi.fn(),
    fsRm: vi.fn(),
    fsMkdtemp: vi.fn(),
    fsWriteFile: vi.fn(),
    fsChmod: vi.fn(),
    execFile: vi.fn(),
    gitRuns: [] as Array<{ root: string; args: string[] }>,
    gitRun: vi.fn(),
}));

vi.mock("vscode", () => ({
    window: {
        showQuickPick: mocks.showQuickPick,
        showInputBox: mocks.showInputBox,
        showOpenDialog: mocks.showOpenDialog,
        showInformationMessage: mocks.showInformationMessage,
        showWarningMessage: mocks.showWarningMessage,
        showErrorMessage: mocks.showErrorMessage,
        withProgress: mocks.withProgress,
    },
    commands: {
        executeCommand: mocks.executeCommand,
    },
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: (key: string) => mocks.configValues.get(key),
            update: mocks.configUpdate,
        }),
        updateWorkspaceFolders: mocks.updateWorkspaceFolders,
    },
    authentication: {
        getSession: mocks.getSession,
    },
    ProgressLocation: {
        Notification: 15,
    },
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
    },
}));

vi.mock("fs/promises", () => ({
    access: mocks.fsAccess,
    rm: mocks.fsRm,
    mkdtemp: mocks.fsMkdtemp,
    writeFile: mocks.fsWriteFile,
    chmod: mocks.fsChmod,
}));

vi.mock("child_process", () => ({
    execFile: mocks.execFile,
}));

vi.mock("../../src/git/executor", () => ({
    GitExecutor: class MockGitExecutor {
        constructor(private readonly root: string) {}

        run(args: string[]): Promise<string> {
            mocks.gitRuns.push({ root: this.root, args });
            return mocks.gitRun(args, this.root);
        }
    },
}));

import { runCloneFlow } from "../../src/services/cloneService";

function errno(code: string, message = code): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
}

function secretStorage(initial?: string): {
    store: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
} {
    let token = initial;
    return {
        get: vi.fn(async () => token),
        store: vi.fn(async (_key: string, value: string) => {
            token = value;
        }),
        delete: vi.fn(async () => {
            token = undefined;
        }),
    };
}

describe("cloneService phase 3", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.configValues.clear();
        mocks.gitRuns.length = 0;

        mocks.showOpenDialog.mockResolvedValue([{ fsPath: "/dest" }]);
        mocks.showInformationMessage.mockResolvedValue(undefined);
        mocks.showWarningMessage.mockResolvedValue(undefined);
        mocks.showErrorMessage.mockResolvedValue(undefined);
        mocks.withProgress.mockImplementation(async (_options, task) =>
            task(
                { report: vi.fn() },
                { isCancellationRequested: false, onCancellationRequested: vi.fn() },
            ),
        );
        mocks.getSession.mockResolvedValue({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        });
        mocks.configUpdate.mockImplementation(async (key: string, value: unknown) => {
            if (value === undefined) {
                mocks.configValues.delete(key);
            } else {
                mocks.configValues.set(key, value);
            }
        });
        mocks.fsAccess.mockRejectedValue(errno("ENOENT", "missing"));
        mocks.fsRm.mockResolvedValue(undefined);
        mocks.fsMkdtemp.mockResolvedValue("/tmp/intelligit-askpass-test");
        mocks.fsWriteFile.mockResolvedValue(undefined);
        mocks.fsChmod.mockResolvedValue(undefined);
        mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
            callback(null, "", "");
            return {} as never;
        });
        mocks.gitRun.mockResolvedValue("");
    });

    it("offers GitHub, GitLab, and SSH clone providers", async () => {
        mocks.showQuickPick.mockResolvedValueOnce(undefined);

        await runCloneFlow();

        const items = mocks.showQuickPick.mock.calls[0][0] as Array<{ provider: string }>;
        expect(items.map((item) => item.provider)).toEqual(["github", "gitlab", "ssh"]);
    });

    it("rejects non-HTTPS GitLab clone URLs", async () => {
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "gitlab" });
        mocks.showInputBox
            .mockResolvedValueOnce("glpat-secret")
            .mockResolvedValueOnce("https://gitlab.com/group/repo.git");

        await runCloneFlow(secretStorage() as never);

        const cloneUrlOptions = mocks.showInputBox.mock.calls[1][0] as {
            validateInput: (value: string) => string | undefined;
        };
        expect(cloneUrlOptions.validateInput("http://gitlab.com/group/repo.git")).toBe(
            "Must be an HTTPS URL",
        );
        expect(cloneUrlOptions.validateInput("https://gitlab.com/group/repo.git")).toBeUndefined();
    });

    it("clones GitHub HTTPS URLs without putting the token in git argv and resets origin", async () => {
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "url" });
        mocks.showInputBox.mockResolvedValueOnce("https://github.com/user/repo.git");
        mocks.getSession.mockResolvedValueOnce({
            id: "session",
            accessToken: "gh-token/with:@chars",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        });

        await runCloneFlow();

        expect(mocks.execFile).toHaveBeenCalledTimes(1);
        const execArgs = mocks.execFile.mock.calls[0][1] as string[];
        const execOptions = mocks.execFile.mock.calls[0][2] as {
            cwd: string;
            env: Record<string, string>;
        };
        expect(execArgs).toEqual(["clone", "https://github.com/user/repo.git", "repo"]);
        expect(JSON.stringify(execArgs)).not.toContain("gh-token");
        expect(execOptions.cwd).toBe("/dest");
        expect(execOptions.env.INTELLIGIT_GIT_USERNAME).toBe("x-access-token");
        expect(execOptions.env.INTELLIGIT_GIT_TOKEN).toBe("gh-token/with:@chars");
        expect(mocks.gitRuns).toContainEqual({
            root: "/dest/repo",
            args: ["remote", "set-url", "origin", "https://github.com/user/repo.git"],
        });
    });

    it("migrates a legacy GitLab token into SecretStorage and clears the old setting", async () => {
        const secrets = secretStorage();
        mocks.configValues.set("gitlab.personalAccessToken", "legacy-token");
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "gitlab" });
        mocks.showInputBox.mockResolvedValueOnce("https://gitlab.com/group/repo.git");

        await runCloneFlow(secrets as never);

        expect(secrets.store).toHaveBeenCalledWith(
            "intelligit.gitlab.personalAccessToken",
            "legacy-token",
        );
        expect(mocks.configUpdate).toHaveBeenCalledWith(
            "gitlab.personalAccessToken",
            undefined,
            true,
        );
    });

    it("aborts when destination access fails for a reason other than missing directory", async () => {
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "ssh" });
        mocks.showInputBox.mockResolvedValueOnce("git@github.com:user/repo.git");
        mocks.fsAccess.mockRejectedValueOnce(errno("EACCES", "permission denied"));

        await runCloneFlow();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            'Cannot access "repo": permission denied',
        );
        expect(mocks.gitRuns).toEqual([]);
    });

    it("aborts when overwrite removal fails", async () => {
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "ssh" });
        mocks.showInputBox.mockResolvedValueOnce("git@github.com:user/repo.git");
        mocks.fsAccess.mockResolvedValueOnce(undefined);
        mocks.showWarningMessage.mockResolvedValueOnce("Overwrite");
        mocks.fsRm.mockRejectedValueOnce(new Error("rm failed"));

        await runCloneFlow();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            'Cannot remove existing directory "repo": rm failed',
        );
        expect(mocks.gitRuns).toEqual([]);
    });
});
