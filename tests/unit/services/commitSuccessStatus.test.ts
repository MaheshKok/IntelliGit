import { afterEach, describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => {
    const statusBarItem = {
        text: "",
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    };
    const get = vi.fn();
    return {
        l10n: { t: (message: string) => message },
        StatusBarAlignment: { Left: 1 },
        window: { createStatusBarItem: vi.fn(() => statusBarItem) },
        workspace: { getConfiguration: vi.fn(() => ({ get })) },
        statusBarItem,
        get,
    };
});

vi.mock("vscode", () => vscodeMock);

import { CommitSuccessStatus } from "../../../src/services/commitSuccessStatus";

describe("CommitSuccessStatus", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        vscodeMock.statusBarItem.text = "";
    });

    it.each([undefined, true])("auto-hides after five seconds when configured as %s", (value) => {
        vi.useFakeTimers();
        vscodeMock.get.mockReturnValue(value);
        const status = new CommitSuccessStatus();

        status.showCommitted();

        expect(vscodeMock.statusBarItem.text).toBe("$(check) Committed successfully.");
        expect(vscodeMock.statusBarItem.show).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(4_999);
        expect(vscodeMock.statusBarItem.hide).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(vscodeMock.statusBarItem.hide).toHaveBeenCalledOnce();
    });

    it("retains the notification for literal false and cancels a previous hide timer", () => {
        vi.useFakeTimers();
        vscodeMock.get.mockReturnValueOnce(true).mockReturnValueOnce(false);
        const status = new CommitSuccessStatus();

        status.showCommitted();
        status.showCommitted();
        vi.advanceTimersByTime(5_000);

        expect(vscodeMock.statusBarItem.show).toHaveBeenCalledTimes(2);
        expect(vscodeMock.statusBarItem.hide).not.toHaveBeenCalled();
    });

    it("restarts the auto-hide timer and disposes the extension-owned item", () => {
        vi.useFakeTimers();
        vscodeMock.get.mockReturnValue(true);
        const status = new CommitSuccessStatus();

        status.showCommitted();
        vi.advanceTimersByTime(4_000);
        status.showCommitted();
        vi.advanceTimersByTime(4_000);
        expect(vscodeMock.statusBarItem.hide).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1_000);
        expect(vscodeMock.statusBarItem.hide).toHaveBeenCalledOnce();

        status.showCommitted();
        status.dispose();
        vi.advanceTimersByTime(5_000);
        expect(vscodeMock.statusBarItem.hide).toHaveBeenCalledOnce();
        expect(vscodeMock.statusBarItem.dispose).toHaveBeenCalledOnce();
    });
});
