import { realpath } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    workspaceFolders: [] as { uri: { scheme: string; fsPath: string } }[],
    getConfiguration: vi.fn(),
    get: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ realpath: vi.fn() }));
vi.mock("vscode", () => ({
    Uri: { file: (fsPath: string) => ({ scheme: "file", fsPath }) },
    workspace: {
        get workspaceFolders() {
            return mocks.workspaceFolders;
        },
        getConfiguration: mocks.getConfiguration,
    },
    l10n: { t: (message: string) => message },
}));

import { readPullUpdateStrategy } from "../../../src/services/updateStrategy";

describe("repository update strategy", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.workspaceFolders = [];
        mocks.get.mockReturnValue("rebase");
        mocks.getConfiguration.mockReturnValue({ get: mocks.get });
        vi.mocked(realpath).mockImplementation(async (root) => String(root));
    });

    it("reads the captured repository resource", async () => {
        expect(await readPullUpdateStrategy("/repo")).toBe("rebase");
        expect(mocks.getConfiguration).toHaveBeenCalledExactlyOnceWith("intelligit", {
            scheme: "file",
            fsPath: "/repo",
        });
        expect(mocks.get).toHaveBeenCalledExactlyOnceWith("updateStrategy");
    });

    it("defaults to rebase when the update strategy is not set", async () => {
        mocks.get.mockReturnValue(undefined);
        await expect(readPullUpdateStrategy("/repo")).resolves.toBe("rebase");
    });

    it("uses independent values for different repository resources", async () => {
        mocks.getConfiguration.mockImplementation((_section, resource) => ({
            get: () => (resource.fsPath === "/repo-a" ? "merge" : "rebase"),
        }));
        expect(await readPullUpdateStrategy("/repo-a")).toBe("merge");
        expect(await readPullUpdateStrategy("/repo-b")).toBe("rebase");
    });

    it("uses the opened project folder when its Git repository is a parent directory", async () => {
        mocks.workspaceFolders = ["/repo/packages/app", "/other"].map((fsPath) => ({
            uri: { scheme: "file", fsPath },
        }));
        mocks.getConfiguration.mockImplementation((_section, resource) => ({
            get: () => (resource.fsPath === "/repo/packages/app" ? "merge" : "rebase"),
        }));
        expect(await readPullUpdateStrategy("/repo")).toBe("merge");
        expect(mocks.getConfiguration).toHaveBeenCalledExactlyOnceWith("intelligit", {
            scheme: "file",
            fsPath: "/repo/packages/app",
        });
    });

    it("rejects conflicting strategies from opened subfolders of one repository", async () => {
        mocks.workspaceFolders = ["/repo/a", "/repo/b"].map((fsPath) => ({
            uri: { scheme: "file", fsPath },
        }));
        mocks.getConfiguration.mockImplementation((_section, resource) => ({
            get: () => (resource.fsPath === "/repo/a" ? "merge" : "rebase"),
        }));
        await expect(readPullUpdateStrategy("/repo")).rejects.toThrow(
            "different intelligit.updateStrategy",
        );
    });

    it("accepts a shared strategy from multiple opened subfolders of one repository", async () => {
        mocks.workspaceFolders = ["/repo/a", "/repo/b"].map((fsPath) => ({
            uri: { scheme: "file", fsPath },
        }));
        mocks.get.mockReturnValue("merge");
        expect(await readPullUpdateStrategy("/repo")).toBe("merge");
    });

    it("prefers an inner symlink folder over an outer direct workspace match", async () => {
        mocks.workspaceFolders = ["/projects", "/linked", "/sibling"].map((fsPath) => ({
            uri: { scheme: "file", fsPath },
        }));
        vi.mocked(realpath).mockImplementation(
            async (root) =>
                ({
                    "/projects": "/projects",
                    "/linked": "/projects/repo",
                    "/sibling": "/projects/repo/nest",
                })[String(root)]!,
        );
        mocks.getConfiguration.mockImplementation((_section, resource) => ({
            get: () => (resource.fsPath === path.join("/linked", "nested") ? "merge" : "rebase"),
        }));
        expect(await readPullUpdateStrategy("/projects/repo/nested")).toBe("merge");
        expect(mocks.getConfiguration).toHaveBeenCalledExactlyOnceWith("intelligit", {
            scheme: "file",
            fsPath: path.join("/linked", "nested"),
        });
    });

    it.each(["ENOENT", "ENOTDIR"])("ignores an absent unrelated folder (%s)", async (code) => {
        mocks.workspaceFolders = ["/deleted", "/linked"].map((fsPath) => ({
            uri: { scheme: "file", fsPath },
        }));
        vi.mocked(realpath).mockImplementation(async (root) => {
            if (root === "/deleted") throw Object.assign(new Error("absent"), { code });
            return "/repo";
        });
        mocks.get.mockReturnValue("merge");
        expect(await readPullUpdateStrategy("/repo")).toBe("merge");
        expect(mocks.getConfiguration).toHaveBeenCalledWith("intelligit", {
            scheme: "file",
            fsPath: path.join("/linked"),
        });
    });

    it("rejects inaccessible folder scope rather than guessing a strategy", async () => {
        mocks.workspaceFolders = [{ uri: { scheme: "file", fsPath: "/inaccessible" } }];
        const error = Object.assign(new Error("denied"), { code: "EACCES" });
        vi.mocked(realpath).mockRejectedValue(error);
        await expect(readPullUpdateStrategy("/repo")).rejects.toBe(error);
        expect(mocks.getConfiguration).not.toHaveBeenCalled();
    });

    it.each([null, "", "squash", true])("rejects unsupported resolved value %s", async (value) => {
        mocks.get.mockReturnValue(value);
        await expect(readPullUpdateStrategy("/repo")).rejects.toThrow(
            "Set intelligit.updateStrategy",
        );
    });
});
