import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    l10nT: vi.fn(),
    logGitOpsWarning: vi.fn(),
    showWarningMessage: vi.fn(),
}));

// `t` is indirected through a mock that marks its output, so the test can tell the
// localized text from the English source it was looked up with.
vi.mock("vscode", () => ({
    l10n: { t: (message: string, ...args: unknown[]) => mocks.l10nT(message, ...args) },
    window: { showWarningMessage: mocks.showWarningMessage },
}));
vi.mock("../../../src/git/operationSupport", () => ({
    logGitOpsWarning: mocks.logGitOpsWarning,
}));

import {
    outdatedGitVersion,
    readGitVersion,
    warnIfGitTooOld,
} from "../../../src/services/gitVersionCheck";

const WARNING_SOURCE =
    "IntelliGit needs Git {0} or later for merge resolution, partial commits and shelf restore, but found Git {1}. Update Git to use these features.";

describe("outdatedGitVersion", () => {
    it.each([
        ["git version 2.30.9\n", "2.30.9"],
        ["git version 2.30.1.windows.1\n", "2.30.1.windows.1"],
        // A lower major with a higher minor is still too old.
        ["git version 1.99.0\n", "1.99.0"],
    ])("reports %j as too old", (output, version) => {
        expect(outdatedGitVersion(output)).toBe(version);
    });

    it.each([
        "git version 2.31.0\n",
        "git version 2.54.0 (Apple Git-157)\n",
        "git version 2.47.1.windows.1\n",
        // A higher major with a lower minor is new enough.
        "git version 3.0.0\n",
    ])("accepts %j", (output) => {
        expect(outdatedGitVersion(output)).toBeUndefined();
    });

    it("does not guess when the output is not a Git version", () => {
        expect(outdatedGitVersion("command not found\n")).toBeUndefined();
    });
});

describe("readGitVersion", () => {
    it("returns the version line of the Git the extension spawns", async () => {
        expect(await readGitVersion()).toMatch(/^git version \d+\.\d+/);
    });
});

describe("warnIfGitTooOld", () => {
    beforeEach(() => {
        mocks.l10nT.mockReset();
        mocks.l10nT.mockImplementation(
            (message: string, ...args: string[]) => `localized(${message})[${args.join(",")}]`,
        );
        mocks.logGitOpsWarning.mockReset();
        mocks.showWarningMessage.mockReset();
        mocks.showWarningMessage.mockResolvedValue(undefined);
    });

    it("shows one localized warning naming the minimum and the found version on older Git", async () => {
        await warnIfGitTooOld(async () => "git version 2.30.9\n");

        expect(mocks.l10nT).toHaveBeenCalledWith(WARNING_SOURCE, "2.31", "2.30.9");
        expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);
        expect(mocks.showWarningMessage).toHaveBeenCalledWith(
            `localized(${WARNING_SOURCE})[2.31,2.30.9]`,
        );
    });

    it("stays quiet on Git 2.31 or later", async () => {
        await warnIfGitTooOld(async () => "git version 2.31.0\n");

        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    });

    it("logs instead of warning when the version cannot be read", async () => {
        const failure = new Error("spawn git ENOENT");

        await warnIfGitTooOld(async () => {
            throw failure;
        });

        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith("Git version check", failure);
    });

    it("reads the version from the Git the extension spawns", async () => {
        // The machines that run this suite have Git 2.31 or later, so the real reader
        // must succeed and find nothing to warn about.
        await warnIfGitTooOld();

        expect(mocks.logGitOpsWarning).not.toHaveBeenCalled();
        expect(mocks.showWarningMessage).not.toHaveBeenCalled();
    });
});
