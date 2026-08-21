import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoadResult } from "../../../src/diff/unifiedDiffTypes";

const mocks = vi.hoisted(() => ({
    panelOpen: vi.fn(async () => undefined),
    logGitOpsWarning: vi.fn(),
}));

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => message },
}));

vi.mock("../../../src/views/DiffViewerPanel", () => ({
    DiffViewerPanel: { open: mocks.panelOpen },
}));

vi.mock("../../../src/git/operationSupport", () => ({
    logGitOpsWarning: mocks.logGitOpsWarning,
}));

import { openUnifiedDiff, type UnifiedDiffRequest } from "../../../src/services/diffService";
import { setDiffViewerExtensionUri } from "../../../src/diff/diffViewerOpener";
import { MAX_DIFF_DP_CELLS, MAX_DIFF_LINES } from "../../../src/diff/diffBudgets";

const extensionUri = { fsPath: "/extension" } as Parameters<typeof setDiffViewerExtensionUri>[0];

function loaded(label: string): ProviderLoadResult {
    return { status: "loaded", bytes: Buffer.from(`${label}\n`), mode: 0o100644 };
}

function provider(label: string, result: ProviderLoadResult) {
    return {
        kind: "provider" as const,
        label,
        load: vi.fn(async () => result),
    };
}

function rejectingProvider(label: string, message: string): UnifiedDiffRequest["left"] {
    return {
        kind: "provider",
        label,
        load: vi.fn(async (_maxOutputBytes: number): Promise<ProviderLoadResult> => {
            throw new Error(message);
        }),
    };
}

function request(
    left: UnifiedDiffRequest["left"] = provider("left", loaded("left")),
    right: UnifiedDiffRequest["right"] = provider("right", loaded("right")),
): UnifiedDiffRequest {
    return {
        repoRoot: "/repo",
        path: "src/example.ts",
        left,
        right,
        languageId: "typescript",
        title: "Example diff",
    };
}

describe("unified diff funnel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setDiffViewerExtensionUri(extensionUri);
    });

    it("opens the viewer rather than the native delegate for a renderable pair", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(request(), nativeDelegate);

        expect(mocks.panelOpen).toHaveBeenCalledOnce();
        expect(nativeDelegate).not.toHaveBeenCalled();
        expect(mocks.panelOpen).toHaveBeenCalledWith(
            expect.objectContaining({
                path: "src/example.ts",
                leftLabel: "left",
                rightLabel: "right",
                leftText: "left\n",
                rightText: "right\n",
                title: "Example diff",
            }),
        );
    });

    it("keeps a confirmed missing side in the viewer as empty text", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(request(provider("left", { status: "missing" })), nativeDelegate);

        expect(nativeDelegate).not.toHaveBeenCalled();
        expect(mocks.panelOpen).toHaveBeenCalledWith(
            expect.objectContaining({ leftText: "", rightText: "right\n" }),
        );
    });

    it("delegates when both sides are confirmed missing", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(
            request(
                provider("left", { status: "missing" }),
                provider("right", { status: "missing" }),
            ),
            nativeDelegate,
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });

    it("delegates and logs when the left-side load rejects", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(
            request(rejectingProvider("left", "left load failed")),
            nativeDelegate,
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
        expect(mocks.logGitOpsWarning).toHaveBeenCalledWith(
            "diffService.openUnifiedDiff.resolve",
            expect.objectContaining({ message: "left load failed" }),
        );
    });

    it("delegates when the right-side load rejects", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(
            request(
                provider("left", loaded("left")),
                rejectingProvider("right", "right load failed"),
            ),
            nativeDelegate,
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });

    it("delegates when a provider load rejects", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(
            request(rejectingProvider("provider", "provider load failed")),
            nativeDelegate,
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });

    it("delegates an over-budget side before opening or computing the viewer", async () => {
        const nativeDelegate = vi.fn(async () => undefined);
        const overBudget: ProviderLoadResult = { status: "over-budget", size: 99 };

        await openUnifiedDiff(request(provider("left", overBudget)), nativeDelegate);

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });

    it("gates the right direction before opening or computing the viewer", async () => {
        const nativeDelegate = vi.fn(async () => undefined);
        const overBudget: ProviderLoadResult = { status: "over-budget", size: 99 };

        await openUnifiedDiff(
            request(provider("left", loaded("left")), provider("right", overBudget)),
            nativeDelegate,
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });

    // The two cases above are caught by the side loader's own per-side byte cap, not by
    // exceedsDiffBudget. These two are the only ones that reach the pair-level budget:
    // both sides load well under the byte cap, so the DP-cell and line caps are the sole
    // reason to delegate. Without them, removing `exceedsDiffBudget` from the funnel
    // breaks no test at all.
    it("delegates when the pair exceeds the DP-cell budget", async () => {
        const nativeDelegate = vi.fn(async () => undefined);
        // One line past the square root of the cell cap, so the pair trips the DP budget
        // while each side stays far under MAX_DIFF_BYTES and under MAX_DIFF_LINES.
        // Derived from the constant, so a re-calibration cannot silently stop exercising
        // this branch the way a hardcoded line count would.
        const lineCount = Math.ceil(Math.sqrt(MAX_DIFF_DP_CELLS)) + 1;
        const wide: ProviderLoadResult = {
            status: "loaded",
            bytes: Buffer.from("a\n".repeat(lineCount)),
            mode: 0o100644,
        };

        await openUnifiedDiff(
            request(provider("left", wide), provider("right", wide)),
            nativeDelegate,
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });

    it("delegates when one side exceeds the line budget", async () => {
        const nativeDelegate = vi.fn(async () => undefined);
        // One line past the line cap, against a single-line right side, so the cell count
        // stays far under the DP cap and only MAX_DIFF_LINES can be the reason.
        const tall: ProviderLoadResult = {
            status: "loaded",
            bytes: Buffer.from("a\n".repeat(MAX_DIFF_LINES + 1)),
            mode: 0o100644,
        };

        await openUnifiedDiff(
            request(provider("left", tall), provider("right", loaded("right"))),
            nativeDelegate,
        );

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });

    it("delegates an ineligible side before opening the viewer", async () => {
        const nativeDelegate = vi.fn(async () => undefined);
        const binary: ProviderLoadResult = {
            status: "loaded",
            bytes: Buffer.from("binary"),
            mode: 0o100644,
            binary: true,
        };

        await openUnifiedDiff(request(provider("left", binary)), nativeDelegate);

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });
});
