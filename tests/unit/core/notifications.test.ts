import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    window: {
        createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        withProgress: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);

import {
    showTimedInformationMessage,
    showTimedWarningMessage,
} from "../../../src/utils/notifications";

describe("notifications", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does not render codicon placeholders in warning titles", async () => {
        showTimedWarningMessage("$(warning) The repo has not been published yet.");

        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "IntelliGit: The repo has not been published yet.",
        );
    });

    it("shows information through native VS Code notifications", () => {
        showTimedInformationMessage("Committed successfully.");

        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            "IntelliGit: Committed successfully.",
        );
        expect(vscodeMock.window.withProgress).not.toHaveBeenCalled();
    });

    it("shows Git operation warnings through manual VS Code warning notifications", async () => {
        const globalWithRequire = globalThis as typeof globalThis & {
            require?: (id: string) => unknown;
        };
        const previousRequire = globalWithRequire.require;
        globalWithRequire.require = (id: string): unknown => {
            if (id === "vscode") return vscodeMock;
            throw new Error(`Unexpected require: ${id}`);
        };
        vi.resetModules();
        try {
            const { logGitOpsWarning } = await import("../../../src/git/operationSupport");
            logGitOpsWarning("numstat unavailable", new Error("boom"), {
                userWarningMessage: "Some commit change stats may be unavailable.",
            });
        } finally {
            globalWithRequire.require = previousRequire;
        }

        expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith(
            "IntelliGit: Some commit change stats may be unavailable.",
        );
        expect(vscodeMock.window.withProgress).not.toHaveBeenCalled();
    });
});
