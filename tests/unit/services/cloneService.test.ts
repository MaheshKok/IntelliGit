import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../helpers/l10nTestHelper";

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
    httpsGet: vi.fn(),
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
    env: {
        language: "en",
    },
    l10n: {
        t: interpolateL10n,
    },
    ProgressLocation: {
        Notification: 15,
    },
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
    },
}));

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: vi.fn(
        async (_message: string, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
            mocks.withProgress(
                {
                    location: 15,
                    title: `IntelliGit: ${_message}`,
                    cancellable: false,
                },
                task,
            ),
    ),
    showTimedInformationMessage: mocks.showInformationMessage,
    showTimedWarningMessage: mocks.showWarningMessage,
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

vi.mock("https", () => ({
    get: mocks.httpsGet,
}));

vi.mock("../../../src/git/executor", () => ({
    GitExecutor: class MockGitExecutor {
        constructor(private readonly root: string) {}

        run(args: string[]): Promise<string> {
            mocks.gitRuns.push({ root: this.root, args });
            return mocks.gitRun(args, this.root);
        }
    },
}));

import { runCloneFlow } from "../../../src/services/cloneService";

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
        mocks.httpsGet.mockImplementation((_url, _options, callback) => {
            const handlers = new Map<string, (chunk?: Buffer) => void>();
            const res = {
                statusCode: 200,
                on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
                    handlers.set(event, handler);
                    return res;
                }),
            };
            queueMicrotask(() => {
                callback(res);
                handlers.get("data")?.(Buffer.from("[]"));
                handlers.get("end")?.();
            });
            const req = {
                on: vi.fn(),
                setTimeout: vi.fn(),
                destroy: vi.fn(),
            };
            return req;
        });
        mocks.gitRun.mockResolvedValue("");
    });

    it("offers GitHub, GitLab, and SSH clone providers", async () => {
        mocks.showQuickPick.mockResolvedValueOnce(undefined);

        await runCloneFlow();

        const items = mocks.showQuickPick.mock.calls[0][0] as Array<{ provider: string }>;
        expect(items.map((item) => item.provider)).toEqual(["github", "gitlab", "ssh"]);
    });

    it("runs SSH clone with the selected destination and inferred repo directory", async () => {
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "ssh" });
        mocks.showInputBox.mockResolvedValueOnce("git@github.com:user/repo.git");

        await runCloneFlow();

        expect(mocks.gitRuns).toEqual([
            {
                root: "/dest",
                args: ["clone", "git@github.com:user/repo.git", "repo"],
            },
        ]);
    });

    it("opens a cloned repository in the current VS Code window when requested", async () => {
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "ssh" });
        mocks.showInputBox.mockResolvedValueOnce("git@github.com:user/repo.git");
        mocks.showInformationMessage.mockResolvedValueOnce("Open in Current Window");

        await runCloneFlow();

        expect(mocks.showInformationMessage).toHaveBeenCalledWith(
            "Cloned repo successfully.",
            "Open in New Window",
            "Open in Current Window",
            "Add to Workspace",
        );
        expect(mocks.executeCommand).toHaveBeenCalledWith(
            "vscode.openFolder",
            { fsPath: "/dest/repo" },
            false,
        );
        expect(mocks.updateWorkspaceFolders).not.toHaveBeenCalled();
    });

    it("falls back to a safe repo directory when the URL basename is unsafe", async () => {
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "ssh" });
        mocks.showInputBox.mockResolvedValueOnce("git@github.com:user/..git");

        await runCloneFlow();

        expect(mocks.gitRuns).toEqual([
            {
                root: "/dest",
                args: ["clone", "git@github.com:user/..git", "repo"],
            },
        ]);
    });

    it("times out stalled GitHub repository listing requests", async () => {
        let timeoutHandler: (() => void) | undefined;
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "browse" });
        mocks.httpsGet.mockImplementation((_url, _options, _callback) => ({
            on: vi.fn((event: string, handler: () => void) => {
                if (event === "timeout") timeoutHandler = handler;
                return undefined;
            }),
            setTimeout: vi.fn((_ms: number, handler: () => void) => {
                timeoutHandler = handler;
                timeoutHandler();
            }),
            destroy: vi.fn(),
        }));

        await runCloneFlow();

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to list GitHub repositories: Request timed out while fetching repositories",
        );
    });

    it("fails explicitly when GitHub repository listing exceeds the bounded page limit", async () => {
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "browse" });
        const fullPage = Array.from({ length: 100 }, (_, index) => ({
            full_name: `user/repo-${index}`,
            clone_url: `https://github.com/user/repo-${index}.git`,
            ssh_url: `git@github.com:user/repo-${index}.git`,
            description: null,
            private: false,
        }));
        mocks.httpsGet.mockImplementation((_url, _options, callback) => {
            const handlers = new Map<string, (chunk?: Buffer) => void>();
            const res = {
                statusCode: 200,
                on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
                    handlers.set(event, handler);
                    return res;
                }),
            };
            queueMicrotask(() => {
                callback(res);
                handlers.get("data")?.(Buffer.from(JSON.stringify(fullPage)));
                handlers.get("end")?.();
            });
            const req = {
                on: vi.fn(),
                setTimeout: vi.fn(),
                destroy: vi.fn(),
            };
            return req;
        });

        await runCloneFlow();

        expect(mocks.httpsGet).toHaveBeenCalledTimes(51);
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to list GitHub repositories: GitHub repository list exceeds 5000 repositories. Enter the clone URL directly instead.",
        );
    });

    it("allows GitHub repository listings with exactly the bounded page limit", async () => {
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "browse" });
        const fullPage = Array.from({ length: 100 }, (_, index) => ({
            full_name: `user/repo-${index}`,
            clone_url: `https://github.com/user/repo-${index}.git`,
            ssh_url: `git@github.com:user/repo-${index}.git`,
            description: null,
            private: false,
        }));
        mocks.httpsGet.mockImplementation((url: string, _options, callback) => {
            const page = Number(new URL(url).searchParams.get("page"));
            const handlers = new Map<string, (chunk?: Buffer) => void>();
            const res = {
                statusCode: 200,
                on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
                    handlers.set(event, handler);
                    return res;
                }),
            };
            queueMicrotask(() => {
                callback(res);
                handlers.get("data")?.(Buffer.from(JSON.stringify(page <= 50 ? fullPage : [])));
                handlers.get("end")?.();
            });
            return {
                on: vi.fn(),
                setTimeout: vi.fn(),
                destroy: vi.fn(),
            };
        });

        await runCloneFlow();

        expect(mocks.httpsGet).toHaveBeenCalledTimes(51);
        expect(mocks.showErrorMessage).not.toHaveBeenCalledWith(
            "Failed to list GitHub repositories: GitHub repository list exceeds 5000 repositories. Enter the clone URL directly instead.",
        );
    });

    it("rejects GitLab clone URLs outside the allowed HTTPS gitlab.com shape", async () => {
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "gitlab" });
        mocks.showInputBox
            .mockResolvedValueOnce("glpat-secret")
            .mockResolvedValueOnce("https://gitlab.com/group/repo.git");

        await runCloneFlow(secretStorage() as never);

        const cloneUrlOptions = mocks.showInputBox.mock.calls[1][0] as {
            validateInput: (value: string) => string | undefined;
        };
        expect(cloneUrlOptions.validateInput("http://gitlab.com/group/repo.git")).toBe(
            "Must be a gitlab.com HTTPS URL",
        );
        expect(cloneUrlOptions.validateInput("https://evil.example/group/repo.git")).toBe(
            "Must be a gitlab.com HTTPS URL",
        );
        expect(
            cloneUrlOptions.validateInput("https://oauth2:token@gitlab.com/group/repo.git"),
        ).toBe("URL must not include embedded credentials");
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

    it("prompts for a replacement GitLab token instead of reusing a legacy token", async () => {
        const secrets = secretStorage("saved-token");
        mocks.configValues.set("gitlab.personalAccessToken", "legacy-token");
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "gitlab" })
            .mockResolvedValueOnce({ value: "new" });
        mocks.showInputBox
            .mockResolvedValueOnce("replacement-token")
            .mockResolvedValueOnce("https://gitlab.com/group/repo.git");

        await runCloneFlow(secrets as never);

        const execOptions = mocks.execFile.mock.calls[0][2] as { env: Record<string, string> };
        expect(execOptions.env.INTELLIGIT_GIT_TOKEN).toBe("replacement-token");
        expect(mocks.configUpdate).not.toHaveBeenCalled();
    });

    it("trims prompted GitLab tokens before saving and cloning", async () => {
        const secrets = secretStorage();
        mocks.showQuickPick.mockResolvedValueOnce({ provider: "gitlab" });
        mocks.showInputBox
            .mockResolvedValueOnce("  replacement-token  ")
            .mockResolvedValueOnce("https://gitlab.com/group/repo.git");
        mocks.showInformationMessage.mockResolvedValueOnce("Save");

        await runCloneFlow(secrets as never);

        expect(secrets.store).toHaveBeenCalledWith(
            "intelligit.gitlab.personalAccessToken",
            "replacement-token",
        );
        const execOptions = mocks.execFile.mock.calls[0][2] as { env: Record<string, string> };
        expect(execOptions.env.INTELLIGIT_GIT_TOKEN).toBe("replacement-token");
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
