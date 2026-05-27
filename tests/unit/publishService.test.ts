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
        openExternal: mocks.openExternal,
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

describe("publishService phase 4", () => {
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

    it("pushes to an existing origin without creating a provider repo or changing remotes", async () => {
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

    it("removes a newly added remote when the authenticated push fails", async () => {
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

        expect(gitOps.addRemote).toHaveBeenCalledWith("origin", "https://github.com/user/repo.git");
        expect(gitOps.removeRemote).toHaveBeenCalledWith("origin");
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(
            "Failed to publish branch: permission denied",
        );
    });
});
