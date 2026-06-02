import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    showQuickPick: vi.fn(),
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

function interpolateL10n(
    message: string,
    args?: Record<string, string | number | boolean> | Array<string | number | boolean>,
): string {
    if (!args) return message;
    if (Array.isArray(args)) {
        return args.reduce(
            (current, value, index) =>
                current.replace(new RegExp(`\\{${index}\\}`, "g"), String(value)),
            message,
        );
    }
    return message.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : match,
    );
}

vi.mock("vscode", () => ({
    window: {
        showQuickPick: mocks.showQuickPick,
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

import { runPublishBranchFlow } from "../../src/services/publishService";
import type { GitOps } from "../../src/git/operations";

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

    it("offers GitHub and GitLab providers before creating a repository", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick.mockResolvedValueOnce(undefined);

        await runPublishBranchFlow(gitOps, "main", "/repo");

        const providerItems = mocks.showQuickPick.mock.calls[0][0] as Array<{ provider: string }>;
        expect(providerItems.map((item) => item.provider)).toEqual(["github", "gitlab"]);
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
        mocks.showInputBox.mockResolvedValueOnce(undefined);

        await runPublishBranchFlow(gitOps, "main", "/workspace/my-project");

        expect(mocks.showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: "Repository name",
                value: "my-project",
            }),
        );
        expect(mocks.httpsRequest).not.toHaveBeenCalled();
    });

    it("adds a clean provider remote and pushes with askpass credentials", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo");

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(gitOps.addRemote).toHaveBeenCalledWith("origin", "https://github.com/user/repo.git");
        const execArgs = mocks.execFile.mock.calls[0][1] as string[];
        const execOptions = mocks.execFile.mock.calls[0][2] as {
            cwd: string;
            env: Record<string, string>;
        };
        expect(execArgs).toEqual(["push", "-u", "origin", "main"]);
        expect(JSON.stringify(execArgs)).not.toContain("gh-token");
        expect(execOptions.cwd).toBe("/repo");
        expect(execOptions.env.INTELLIGIT_GIT_USERNAME).toBe("x-access-token");
        expect(execOptions.env.INTELLIGIT_GIT_TOKEN).toBe("gh-token/with:@chars");
        expect(mocks.fsRm).toHaveBeenCalledWith("/tmp/intelligit-askpass-test", {
            recursive: true,
            force: true,
        });
    });

    it("surfaces a clear error when GitHub repository creation times out", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo");
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
        mocks.showInputBox.mockResolvedValueOnce("repo");
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
        mocks.showInputBox.mockResolvedValueOnce("repo");
        mockCreateRepoResponse(201, "{not-json");

        await runPublishBranchFlow(gitOps, "main", "/repo", secretStorage("glpat-token") as never);

        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to create repository: Invalid GitLab API response",
        );
        expect(gitOps.addRemote).not.toHaveBeenCalled();
    });

    it("keeps an existing origin untouched when the user chooses to push there", async () => {
        const gitOps = makeGitOps(["origin"]);
        mocks.showQuickPick.mockResolvedValueOnce({ action: "existing" });

        await runPublishBranchFlow(gitOps, "main", "/repo");

        expect(gitOps.pushWithUpstream).toHaveBeenCalledWith("origin", "main");
        expect(mocks.httpsRequest).not.toHaveBeenCalled();
        expect(mocks.getSession).not.toHaveBeenCalled();
        expect(gitOps.addRemote).not.toHaveBeenCalled();
        expect(gitOps.removeRemote).not.toHaveBeenCalled();
        expect(mocks.execFile).not.toHaveBeenCalled();
    });

    it("supports creating a provider remote under a non-origin name when origin exists", async () => {
        const gitOps = makeGitOps(["origin"]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ action: "create" })
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "public" });
        mocks.showInputBox.mockResolvedValueOnce("upstream").mockResolvedValueOnce("repo");

        await runPublishBranchFlow(gitOps, "feature/test", "/repo");

        expect(gitOps.addRemote).toHaveBeenCalledWith(
            "upstream",
            "https://github.com/user/repo.git",
        );
        expect(mocks.execFile.mock.calls[0][1]).toEqual(["push", "-u", "upstream", "feature/test"]);
    });

    it("removes a newly added provider remote when the authenticated push fails", async () => {
        const gitOps = makeGitOps([]);
        mocks.showQuickPick
            .mockResolvedValueOnce({ provider: "github" })
            .mockResolvedValueOnce({ value: "private" });
        mocks.showInputBox.mockResolvedValueOnce("repo");
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
        mocks.showInputBox.mockResolvedValueOnce("repo");

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
