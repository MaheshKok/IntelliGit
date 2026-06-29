import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../helpers/l10nTestHelper";

const mocks = vi.hoisted(() => ({
    showQuickPick: vi.fn(),
    createQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn(),
    openExternal: vi.fn(),
    getSession: vi.fn(),
    configValues: new Map<string, unknown>(),
    configUpdate: vi.fn(),
    httpsRequest: vi.fn(),
    fsMkdtemp: vi.fn(),
    fsWriteFile: vi.fn(),
    fsChmod: vi.fn(),
    fsRm: vi.fn(),
    execFile: vi.fn(),
}));

vi.mock("vscode", () => ({
    window: {
        showQuickPick: mocks.showQuickPick,
        createQuickPick: mocks.createQuickPick,
        showInputBox: mocks.showInputBox,
        showInformationMessage: mocks.showInformationMessage,
        showWarningMessage: mocks.showWarningMessage,
        showErrorMessage: mocks.showErrorMessage,
        withProgress: mocks.withProgress,
    },
    workspace: {
        getConfiguration: () => ({
            get: (key: string) => mocks.configValues.get(key),
            update: mocks.configUpdate,
        }),
    },
    authentication: {
        getSession: mocks.getSession,
    },
    env: {
        language: "en",
        openExternal: mocks.openExternal,
    },
    l10n: {
        t: interpolateL10n,
    },
    ProgressLocation: {
        Notification: 15,
    },
    Uri: {
        parse: (value: string) => ({ value }),
    },
}));

interface MockRemoteChoice {
    action: "existing" | "create";
    alwaysShow?: boolean;
}

interface MockQuickPick {
    items: MockRemoteChoice[];
    selectedItems: MockRemoteChoice[];
    value: string;
    assignedValues: string[];
    placeholder?: string;
    onDidAccept: ReturnType<typeof vi.fn>;
    onDidHide: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
}

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

vi.mock("https", () => ({
    request: mocks.httpsRequest,
}));

vi.mock("fs/promises", () => ({
    mkdtemp: mocks.fsMkdtemp,
    writeFile: mocks.fsWriteFile,
    chmod: mocks.fsChmod,
    rm: mocks.fsRm,
}));

vi.mock("child_process", () => ({
    execFile: mocks.execFile,
}));

import { runPublishBranchFlow } from "../../../src/services/publishService";
import type { GitOps } from "../../../src/git/operations";

function makeGitOps(remotes: string[] = []): GitOps {
    return {
        getRemotes: vi.fn(async () => remotes),
        addRemote: vi.fn(async () => undefined),
        removeRemote: vi.fn(async () => undefined),
        pushWithUpstream: vi.fn(async () => ""),
        branchHasUpstream: vi.fn(async () => true),
    } as unknown as GitOps;
}

function mockGitHubCreateRepo(): void {
    mocks.httpsRequest.mockImplementation((_url, _options, callback) => {
        const handlers = new Map<string, (chunk?: Buffer) => void>();
        const res = {
            statusCode: 201,
            on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
                handlers.set(event, handler);
                return res;
            }),
        };
        return {
            on: vi.fn(),
            setTimeout: vi.fn(),
            destroy: vi.fn(),
            write: vi.fn(),
            end: vi.fn(() => {
                callback(res);
                handlers.get("data")?.(
                    Buffer.from(
                        JSON.stringify({
                            clone_url: "https://github.com/user/repo.git",
                            ssh_url: "git@github.com:user/repo.git",
                            html_url: "https://github.com/user/repo",
                        }),
                    ),
                );
                handlers.get("end")?.();
            }),
        };
    });
}

function mockCreateRepoResponse(statusCode: number, body: string): void {
    mocks.httpsRequest.mockImplementation((_url, _options, callback) => {
        const handlers = new Map<string, (chunk?: Buffer) => void>();
        const res = {
            statusCode,
            on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
                handlers.set(event, handler);
                return res;
            }),
        };
        return {
            on: vi.fn(),
            setTimeout: vi.fn(),
            destroy: vi.fn(),
            write: vi.fn(),
            end: vi.fn(() => {
                callback(res);
                handlers.get("data")?.(Buffer.from(body));
                handlers.get("end")?.();
            }),
        };
    });
}

function mockCreateRepoResponseEvent(event: "error" | "aborted", err?: Error): void {
    mocks.httpsRequest.mockImplementation((_url, _options, callback) => {
        const handlers = new Map<string, (arg?: unknown) => void>();
        const res = {
            statusCode: 200,
            on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
                handlers.set(event, handler);
                return res;
            }),
        };
        return {
            on: vi.fn(),
            setTimeout: vi.fn(),
            destroy: vi.fn(),
            write: vi.fn(),
            end: vi.fn(() => {
                callback(res);
                handlers.get(event)?.(err);
            }),
        };
    });
}

function mockCreateRepoTimeout(): void {
    mocks.httpsRequest.mockImplementation((_url, _options, _callback) => {
        let timeoutHandler: (() => void) | undefined;
        let errorHandler: ((err: Error) => void) | undefined;
        const req = {
            on: vi.fn((event: string, handler: () => void) => {
                if (event === "timeout") timeoutHandler = handler;
                if (event === "error") errorHandler = handler as (err: Error) => void;
                return req;
            }),
            setTimeout: vi.fn((_ms: number, handler?: () => void) => {
                timeoutHandler = handler;
                return req;
            }),
            destroy: vi.fn(),
            write: vi.fn(),
            end: vi.fn(() => {
                if (timeoutHandler) {
                    timeoutHandler();
                } else {
                    errorHandler?.(new Error("request ended without timeout handler"));
                }
            }),
        };
        return req;
    });
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

function mockRemotePickerSelection(action: "existing" | "create", value: string): MockQuickPick {
    let accept: (() => void) | undefined;
    let hide: (() => void) | undefined;
    let currentValue = "";
    const picker: MockQuickPick = {
        items: [],
        selectedItems: [],
        value: "",
        assignedValues: [],
        onDidAccept: vi.fn((handler: () => void) => {
            accept = handler;
            return { dispose: vi.fn() };
        }),
        onDidHide: vi.fn((handler: () => void) => {
            hide = handler;
            return { dispose: vi.fn() };
        }),
        show: vi.fn(() => {
            picker.value = value;
            picker.selectedItems = picker.items
                .filter((item) => item.action === action)
                .slice(0, 1);
            accept?.();
        }),
        hide: vi.fn(() => {
            hide?.();
        }),
        dispose: vi.fn(),
    };
    Object.defineProperty(picker, "value", {
        get: () => currentValue,
        set: (next: string) => {
            currentValue = next;
            picker.assignedValues.push(next);
        },
    });
    mocks.createQuickPick.mockReturnValueOnce(picker);
    return picker;
}

describe("publishService phase 5", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.configValues.clear();
        mocks.showInformationMessage.mockResolvedValue(undefined);
        mocks.showWarningMessage.mockResolvedValue(undefined);
        mocks.showErrorMessage.mockResolvedValue(undefined);
        mocks.withProgress.mockImplementation(async (_options, task) => task());
        mocks.getSession.mockResolvedValue({
            id: "session",
            accessToken: "gh-token/with:@chars",
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
        mocks.fsMkdtemp.mockResolvedValue("/tmp/intelligit-askpass-test");
        mocks.fsWriteFile.mockResolvedValue(undefined);
        mocks.fsChmod.mockResolvedValue(undefined);
        mocks.fsRm.mockResolvedValue(undefined);
        mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
            callback(null, "", "");
            return {} as never;
        });
        mockGitHubCreateRepo();
    });

    it("offers all publish providers before creating a repository", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick.mockResolvedValueOnce(undefined);

        await runPublishBranchFlow(gitOps, "main", "/repo");

        const providerItems = mocks.showQuickPick.mock.calls[0][0] as Array<{ provider: string }>;
        expect(providerItems.map((item) => item.provider)).toEqual([
            "github",
            "gitlab",
            "bitbucket-cloud",
            "bitbucket-server",
        ]);
        expect(mocks.httpsRequest).not.toHaveBeenCalled();
    });

    it("offers private and public visibility after provider selection", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce(undefined);

        await runPublishBranchFlow(gitOps, "main", "/repo");

        const visibilityItems = mocks.showQuickPick.mock.calls[1][0] as Array<{ value: string }>;
        expect(visibilityItems.map((item) => item.value)).toEqual(["private", "public"]);
        expect(mocks.httpsRequest).not.toHaveBeenCalled();
    });

    it("defaults the repository name to the workspace folder name", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo").mockResolvedValueOnce(undefined);

        await runPublishBranchFlow(gitOps, "main", "/workspace/my-project");

        expect(mocks.showInputBox).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                prompt: "Repository name",
                value: "my-project",
            }),
        );
        expect(mocks.showInputBox).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                prompt: "Published branch name",
                value: "main",
            }),
        );
        expect(mocks.httpsRequest).not.toHaveBeenCalled();
    });

    it("adds a clean provider remote and pushes with askpass credentials", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo").mockResolvedValueOnce("main");

        await runPublishBranchFlow(gitOps, "master", "/repo");

        expect(mocks.showInputBox).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                prompt: "Published branch name",
                value: "master",
            }),
        );
        expect(gitOps.addRemote).toHaveBeenCalledWith("origin", "https://github.com/user/repo.git");
        const execArgs = mocks.execFile.mock.calls[0][1] as string[];
        const execOptions = mocks.execFile.mock.calls[0][2] as {
            cwd: string;
            env: Record<string, string>;
        };
        expect(execArgs).toEqual(["push", "-u", "origin", "master:main"]);
        expect(JSON.stringify(execArgs)).not.toContain("gh-token");
        expect(execOptions.cwd).toBe("/repo");
        expect(execOptions.env.INTELLIGIT_GIT_USERNAME).toBe("x-access-token");
        expect(execOptions.env.INTELLIGIT_GIT_TOKEN).toBe("gh-token/with:@chars");
        expect(mocks.fsRm).toHaveBeenCalledWith("/tmp/intelligit-askpass-test", {
            recursive: true,
            force: true,
        });
    });

    it("creates a Bitbucket Cloud repository before pushing", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "bitbucket-cloud" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox
            .mockResolvedValueOnce("repo")
            .mockResolvedValueOnce("workspace")
            .mockResolvedValueOnce("main")
            .mockResolvedValueOnce("bb-user")
            .mockResolvedValueOnce("bb-token");
        mockCreateRepoResponse(
            200,
            JSON.stringify({
                links: {
                    clone: [
                        {
                            name: "https",
                            href: "https://bitbucket.org/workspace/repo.git",
                        },
                    ],
                    html: { href: "https://bitbucket.org/workspace/repo" },
                },
            }),
        );

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(mocks.httpsRequest.mock.calls[0][0]).toBe(
            "https://api.bitbucket.org/2.0/repositories/workspace/repo",
        );
        expect(mocks.httpsRequest.mock.calls[0][1]).toMatchObject({
            method: "POST",
            headers: {
                Authorization: `Basic ${Buffer.from("bb-user:bb-token").toString("base64")}`,
            },
        });
        expect(gitOps.addRemote).toHaveBeenCalledWith(
            "origin",
            "https://bitbucket.org/workspace/repo.git",
        );
        const execOptions = mocks.execFile.mock.calls[0][2] as {
            env: Record<string, string>;
        };
        expect(execOptions.env.INTELLIGIT_GIT_USERNAME).toBe("bb-user");
        expect(execOptions.env.INTELLIGIT_GIT_TOKEN).toBe("bb-token");
    });

    it("creates a Bitbucket Server repository before pushing", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "bitbucket-server" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox
            .mockResolvedValueOnce("repo")
            .mockResolvedValueOnce("https://bitbucket.example.com/")
            .mockResolvedValueOnce("PRJ")
            .mockResolvedValueOnce("main")
            .mockResolvedValueOnce("bb-user")
            .mockResolvedValueOnce("bb-token");
        mockCreateRepoResponse(
            201,
            JSON.stringify({
                links: {
                    clone: [
                        {
                            name: "http",
                            href: "https://bitbucket.example.com/scm/prj/repo.git",
                        },
                    ],
                    self: [{ href: "https://bitbucket.example.com/projects/PRJ/repos/repo" }],
                },
            }),
        );

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(mocks.httpsRequest.mock.calls[0][0]).toBe(
            "https://bitbucket.example.com/rest/api/1.0/projects/PRJ/repos",
        );
        expect(mocks.httpsRequest.mock.calls[0][1]).toMatchObject({
            method: "POST",
            headers: {
                Authorization: `Basic ${Buffer.from("bb-user:bb-token").toString("base64")}`,
            },
        });
        expect(mocks.showErrorMessage).not.toHaveBeenCalled();
        expect(gitOps.addRemote).toHaveBeenCalledWith(
            "origin",
            "https://bitbucket.example.com/scm/prj/repo.git",
        );
    });

    it("reports Bitbucket Cloud response stream errors", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "bitbucket-cloud" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox
            .mockResolvedValueOnce("repo")
            .mockResolvedValueOnce("workspace")
            .mockResolvedValueOnce("main")
            .mockResolvedValueOnce("bb-user")
            .mockResolvedValueOnce("bb-token");
        mockCreateRepoResponseEvent("error", new Error("socket closed"));

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to create repository: socket closed",
        );
        expect(gitOps.addRemote).not.toHaveBeenCalled();
    });

    it("reports Bitbucket Server aborted responses", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "bitbucket-server" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox
            .mockResolvedValueOnce("repo")
            .mockResolvedValueOnce("https://bitbucket.example.com/")
            .mockResolvedValueOnce("PRJ")
            .mockResolvedValueOnce("main")
            .mockResolvedValueOnce("bb-user")
            .mockResolvedValueOnce("bb-token");
        mockCreateRepoResponseEvent("aborted");

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to create repository: Response aborted while creating repository",
        );
        expect(gitOps.addRemote).not.toHaveBeenCalled();
    });

    it("surfaces a clear error when GitHub repository creation times out", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo").mockResolvedValueOnce("main");
        mockCreateRepoTimeout();

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to create repository: Request timed out while creating repository",
        );
        expect(gitOps.addRemote).not.toHaveBeenCalled();
    });

    it("reports malformed GitHub create-repo responses instead of throwing", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo").mockResolvedValueOnce("main");
        mockCreateRepoResponse(201, "{not-json");

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to create repository: Invalid GitHub API response",
        );
        expect(gitOps.addRemote).not.toHaveBeenCalled();
    });

    it("reports malformed GitLab create-project responses instead of throwing", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "gitlab" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo").mockResolvedValueOnce("main");
        mockCreateRepoResponse(201, "{not-json");

        await runPublishBranchFlow(gitOps, "main", "/repo", secretStorage("glpat-token") as never);

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to create repository: Invalid GitLab API response",
        );
        expect(gitOps.addRemote).not.toHaveBeenCalled();
    });

    it("surfaces structured GitLab validation messages", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "gitlab" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo").mockResolvedValueOnce("main");
        mockCreateRepoResponse(
            400,
            JSON.stringify({
                message: {
                    name: ["has already been taken"],
                    path: ["is invalid"],
                    base: [{ detail: "namespace is unavailable" }],
                },
            }),
        );

        await runPublishBranchFlow(gitOps, "main", "/repo", secretStorage("glpat-token") as never);

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to create repository: has already been taken; is invalid; namespace is unavailable",
        );
        expect(gitOps.addRemote).not.toHaveBeenCalled();
    });

    it("keeps an existing origin untouched when the user chooses to push there", async () => {
        const gitOps = makeGitOps(["origin"]);
        const picker = mockRemotePickerSelection("existing", "origin/codex/publish-push-branch-ui");

        await runPublishBranchFlow(gitOps, "codex/publish-push-branch-ui", "/repo");

        expect(gitOps.pushWithUpstream).toHaveBeenCalledWith(
            "origin",
            "codex/publish-push-branch-ui",
            "codex/publish-push-branch-ui",
        );
        expect(picker.assignedValues).toContain("origin/codex/publish-push-branch-ui");
        expect(picker.items.every((item) => item.alwaysShow)).toBe(true);
        expect(mocks.showInputBox).not.toHaveBeenCalled();
        expect(mocks.httpsRequest).not.toHaveBeenCalled();
        expect(mocks.getSession).not.toHaveBeenCalled();
        expect(gitOps.addRemote).not.toHaveBeenCalled();
        expect(gitOps.removeRemote).not.toHaveBeenCalled();
        expect(mocks.execFile).not.toHaveBeenCalled();
    });

    it("supports creating a provider remote under a non-origin name when origin exists", async () => {
        const gitOps = makeGitOps(["origin"]);
        mockRemotePickerSelection("create", "upstream/feature/test");
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "public" });
        mocks.showInputBox.mockResolvedValueOnce("repo");

        await runPublishBranchFlow(gitOps, "feature/test", "/repo");

        expect(gitOps.addRemote).toHaveBeenCalledWith(
            "upstream",
            "https://github.com/user/repo.git",
        );
        expect(mocks.showInputBox).toHaveBeenCalledTimes(1);
        expect(mocks.execFile.mock.calls[0][1]).toEqual(["push", "-u", "upstream", "feature/test"]);
    });

    it("removes a newly added provider remote when the authenticated push fails", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo").mockResolvedValueOnce("main");
        mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
            callback(new Error("push failed"), "", "permission denied");
            return {} as never;
        });

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(gitOps.removeRemote).toHaveBeenCalledWith("origin");
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to publish branch: permission denied",
        );
    });

    it("migrates a legacy GitLab token before creating the project", async () => {
        const gitOps = makeGitOps([]);
        const secrets = secretStorage();
        mocks.configValues.set("gitlab.personalAccessToken", "legacy-token");
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "gitlab" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo").mockResolvedValueOnce("main");

        await runPublishBranchFlow(gitOps, "main", "/repo", secrets as never);

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
});
