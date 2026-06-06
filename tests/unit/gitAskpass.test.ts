import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    execFile: vi.fn(),
    fsChmod: vi.fn(),
    fsMkdtemp: vi.fn(),
    fsRm: vi.fn(),
    fsWriteFile: vi.fn(),
}));

vi.mock("child_process", () => ({
    execFile: mocks.execFile,
}));

vi.mock("fs/promises", () => ({
    chmod: mocks.fsChmod,
    mkdtemp: mocks.fsMkdtemp,
    rm: mocks.fsRm,
    writeFile: mocks.fsWriteFile,
}));

vi.mock("os", () => ({
    tmpdir: () => "/tmp",
}));

vi.mock("path", async () => {
    const actual = await vi.importActual<typeof import("path")>("path");
    return actual;
});

import { runGitCommandWithAskpass } from "../../src/services/gitAskpass";

describe("git askpass helper", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.fsMkdtemp.mockResolvedValue("/tmp/intelligit-askpass-test");
        mocks.fsWriteFile.mockResolvedValue(undefined);
        mocks.fsChmod.mockResolvedValue(undefined);
        mocks.fsRm.mockResolvedValue(undefined);
        mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
            callback(null, "", "");
            return {} as never;
        });
    });

    it("removes the temp askpass directory if script creation fails", async () => {
        const failure = new Error("disk full");
        mocks.fsWriteFile.mockRejectedValueOnce(failure);

        await expect(
            runGitCommandWithAskpass(
                "/repo",
                ["push"],
                { username: "oauth2", token: "secret-token" },
            ),
        ).rejects.toThrow("disk full");

        expect(mocks.execFile).not.toHaveBeenCalled();
        expect(mocks.fsRm).toHaveBeenCalledWith("/tmp/intelligit-askpass-test", {
            recursive: true,
            force: true,
        });
    });
});
