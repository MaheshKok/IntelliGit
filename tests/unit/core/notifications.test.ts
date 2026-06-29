import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
    window: {
        showWarningMessage: vi.fn(),
    },
}));

vi.mock("vscode", () => vscodeMock);

import { showTimedWarningMessage } from "../../../src/utils/notifications";

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
});
