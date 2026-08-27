import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoadResult } from "../../../src/diff/unifiedDiffTypes";

const mocks = vi.hoisted(() => ({
    panelOpen: vi.fn(async () => undefined),
    claimSession: vi.fn(),
    clearSessionBinding: vi.fn(() => true),
    logGitOpsWarning: vi.fn(),
    trackDiffTab: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => message },
}));

vi.mock("../../../src/views/DiffViewerPanel", () => ({
    DiffViewerPanel: {
        open: mocks.panelOpen,
        claimSession: mocks.claimSession,
        clearSessionBinding: mocks.clearSessionBinding,
    },
}));

vi.mock("../../../src/git/operationSupport", () => ({
    logGitOpsWarning: mocks.logGitOpsWarning,
}));

vi.mock("../../../src/diff/diffViewSwitch", () => ({
    trackDiffTab: mocks.trackDiffTab,
}));

import { openUnifiedDiff, type UnifiedDiffRequest } from "../../../src/services/diffService";
import { setDiffViewerExtensionUri } from "../../../src/diff/diffViewerOpener";
import { MAX_DIFF_DP_CELLS, MAX_DIFF_LINES } from "../../../src/diff/diffBudgets";

const extensionUri = { fsPath: "/extension" } as Parameters<typeof setDiffViewerExtensionUri>[0];

function loaded(label: string): ProviderLoadResult {
    return { status: "loaded", bytes: Buffer.from(`${label}\n`), mode: 0o100644 };
}

function provider(label: string, result: ProviderLoadResult, identity?: string) {
    return {
        kind: "provider" as const,
        label,
        load: vi.fn(async () => result),
        identity: identity ?? label,
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

function rejectingProvider(label: string, message: string): UnifiedDiffRequest["left"] {
    return {
        kind: "provider",
        label,
        identity: label,
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
        mocks.clearSessionBinding.mockImplementation(() => true);
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

    // The reader pressed "Show Diff in VS Code" on a tab that was rendering perfectly well, so
    // this is a request rather than a capability check -- the one case where the native editor
    // is chosen instead of settled for. Honoured before either side loads: making them wait for
    // a load whose only result is to be discarded would be the same as ignoring them.
    it("sends a renderable diff to the native editor when the reader asks for it", async () => {
        const nativeDelegate = vi.fn(async () => undefined);
        const left = provider("left", loaded("left"));
        const right = provider("right", loaded("right"));

        await openUnifiedDiff(request(left, right), nativeDelegate, "vscode");

        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
        expect(
            left.load,
            "loaded a side for a diff that was never going to be rendered",
        ).not.toHaveBeenCalled();
        expect(right.load).not.toHaveBeenCalled();
    });

    // The opposite button forces nothing. "intelligit" is the reader asking to come back, and
    // the viewer still gets to decline a pair it cannot render -- so this must take the ordinary
    // route, not a mirror-image short-circuit.
    it("still routes through the viewer when the IntelliGit surface is asked for", async () => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(request(), nativeDelegate, "intelligit");

        expect(mocks.panelOpen).toHaveBeenCalledOnce();
        expect(nativeDelegate).not.toHaveBeenCalled();
    });

    // The viewer panel is a singleton that silently declines a stale generation, and the call
    // that opens it awaits -- so a second request can start and win the panel while the first is
    // still inside. The loser drew nothing, so it must not report a landed tab: the tab now on
    // screen belongs to the winner, and recording it against the loser's reopen thunk would point
    // the view-switch buttons at a document the reader never asked for.
    it("records no tab for an open that lost the panel to a newer request", async () => {
        const nativeDelegate = vi.fn(async () => undefined);
        const insidePanelOpen = deferred<undefined>();
        const held = deferred<undefined>();
        mocks.panelOpen.mockImplementationOnce(async () => {
            insidePanelOpen.resolve(undefined);
            await held.promise;
        });

        const superseded = openUnifiedDiff(request(), nativeDelegate);
        await insidePanelOpen.promise;
        await openUnifiedDiff(request(), nativeDelegate);
        held.resolve(undefined);
        await superseded;

        expect(mocks.panelOpen, "the second request never reached the panel").toHaveBeenCalledTimes(
            2,
        );
        expect(
            mocks.trackDiffTab,
            "the superseded open was recorded as though it had drawn a panel",
        ).toHaveBeenCalledOnce();
    });

    // The same rule at the other landing, and the one the test above cannot reach: there the
    // loser was inside the PANEL, here it is inside the native fallback, awaiting the delegate
    // that opens VS Code's own diff. Both are awaits a newer request can arrive during, and
    // both leave the loser having drawn nothing a reader can see -- `transitionToNativeFallback`
    // declines outright once the session it was handed has been cancelled. Reporting a landed
    // tab from either would bind the winner's tab to the loser's reopen thunk.
    // Every way in is driven, not just the cheapest one: the three landings are three separate
    // returns, and a single case leaves the other two free to report a tab they never drew.
    it.each([
        // Honoured before either side loads -- the reader asked for the other surface.
        ["the reader asked for the native diff", () => request(), "vscode" as const],
        ["a side load rejects", () => request(rejectingProvider("left", "boom")), undefined],
        // Both sides absent is the viewer's own refusal rather than a thrown load, so it is the
        // only one of the three that reaches the last landing.
        [
            "the path is absent from both sides",
            () =>
                request(
                    provider("left", { status: "missing" }),
                    provider("right", { status: "missing" }),
                ),
            undefined,
        ],
    ])(
        "records no tab when %s and a newer request cancels the fallback mid-flight",
        async (_reason, makeRequest, preferredView) => {
            const insideDelegate = deferred<undefined>();
            const held = deferred<undefined>();
            const supersededDelegate = vi.fn(async () => {
                insideDelegate.resolve(undefined);
                await held.promise;
            });
            const winningDelegate = vi.fn(async () => undefined);

            const superseded = openUnifiedDiff(makeRequest(), supersededDelegate, preferredView);
            await insideDelegate.promise;
            await openUnifiedDiff(request(), winningDelegate, "vscode");
            held.resolve(undefined);
            await superseded;

            expect(
                supersededDelegate,
                "the first fallback never ran, so it was already stale rather than superseded",
            ).toHaveBeenCalledOnce();
            expect(winningDelegate).toHaveBeenCalledOnce();
            expect(
                mocks.trackDiffTab,
                "the fallback superseded mid-flight was recorded as though it had landed a tab",
            ).toHaveBeenCalledOnce();
        },
    );

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

    it("discards a slow opening completion after a faster opening wins", async () => {
        const slow = deferred<ProviderLoadResult>();
        const nativeA = vi.fn(async () => undefined);
        const nativeB = vi.fn(async () => undefined);
        const slowA = provider("slow A", {
            status: "loaded",
            bytes: Buffer.from("slow A\n"),
            mode: 0o100644,
        });
        slowA.load = vi.fn(async () => slow.promise);

        const openingA = openUnifiedDiff(request(slowA), nativeA);
        await openUnifiedDiff(
            request(
                provider("fast B left", loaded("fast B left")),
                provider("fast B right", loaded("fast B right")),
            ),
            nativeB,
        );
        slow.resolve(loaded("slow A"));
        await openingA;

        expect(mocks.panelOpen).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).toHaveBeenLastCalledWith(
            expect.objectContaining({ rightText: "fast B right\n" }),
        );
        expect(nativeA).not.toHaveBeenCalled();
    });

    it("keeps a newer panel open while a stale fallback delegate finishes", async () => {
        const delegateGate = deferred<void>();
        let fallbackToken: { isCancellationRequested: boolean } | undefined;
        let nativeSideEffect = false;
        const nativeA = vi.fn(async (token: { isCancellationRequested: boolean }) => {
            fallbackToken = token;
            expect(token.isCancellationRequested).toBe(false);
            await delegateGate.promise;
            if (!token.isCancellationRequested) nativeSideEffect = true;
        });
        const nativeB = vi.fn(async () => undefined);

        const fallbackA = openUnifiedDiff(
            request(
                provider("fallback", { status: "over-budget", size: 99 }),
                provider("right", loaded("right")),
            ),
            nativeA,
        );
        await vi.waitFor(() => expect(nativeA).toHaveBeenCalledOnce());

        await openUnifiedDiff(
            request(provider("B left", loaded("B left")), provider("B right", loaded("B right"))),
            nativeB,
        );
        expect(fallbackToken?.isCancellationRequested).toBe(true);
        expect(mocks.panelOpen).toHaveBeenLastCalledWith(
            expect.objectContaining({ leftText: "B left\n", rightText: "B right\n" }),
        );

        delegateGate.resolve();
        await fallbackA;
        expect(nativeSideEffect).toBe(false);
        expect(mocks.clearSessionBinding).toHaveBeenCalledOnce();
    });

    it("detaches the panel before invoking a fallback delegate", async () => {
        const order: string[] = [];
        mocks.clearSessionBinding.mockImplementation(() => {
            order.push("detach");
            return true;
        });
        const nativeDelegate = vi.fn(async () => {
            order.push("delegate");
        });

        await openUnifiedDiff(
            request(provider("fallback", { status: "over-budget", size: 99 })),
            nativeDelegate,
        );

        expect(order).toEqual(["detach", "delegate"]);
    });

    it.each([
        [
            "binary",
            { status: "loaded", bytes: Buffer.from("binary"), mode: 0o100644, binary: true },
        ],
        ["invalid UTF-8", { status: "loaded", bytes: Buffer.from([0xc3, 0x28]), mode: 0o100644 }],
        ["symlink", { status: "loaded", bytes: Buffer.from("link"), mode: 0o120000 }],
        ["submodule", { status: "loaded", bytes: Buffer.from("module"), mode: 0o160000 }],
        ["over-budget", { status: "over-budget", size: 99 }],
    ] as const)("transitions to native fallback for %s", async (_reason, result) => {
        const nativeDelegate = vi.fn(async () => undefined);

        await openUnifiedDiff(request(provider("left", result)), nativeDelegate);

        expect(mocks.clearSessionBinding).toHaveBeenCalledOnce();
        expect(nativeDelegate).toHaveBeenCalledOnce();
        expect(mocks.panelOpen).not.toHaveBeenCalled();
    });

    it.each([
        [
            "binary",
            { status: "loaded", bytes: Buffer.from("binary"), mode: 0o100644, binary: true },
        ],
        ["invalid UTF-8", { status: "loaded", bytes: Buffer.from([0xc3, 0x28]), mode: 0o100644 }],
        ["symlink", { status: "loaded", bytes: Buffer.from("link"), mode: 0o120000 }],
        ["submodule", { status: "loaded", bytes: Buffer.from("module"), mode: 0o160000 }],
        ["over-budget", { status: "over-budget", size: 99 }],
    ] as const)(
        "clears the live binding before mid-session fallback for %s",
        async (_reason, result) => {
            const firstDelegate = vi.fn(async () => undefined);
            const secondDelegate = vi.fn(async () => undefined);

            await openUnifiedDiff(request(), firstDelegate);

            expect(mocks.panelOpen).toHaveBeenCalledOnce();
            expect(mocks.claimSession).toHaveBeenCalledOnce();
            const firstGeneration = mocks.claimSession.mock.calls[0]?.[0].generation;

            await openUnifiedDiff(request(provider("left", result)), secondDelegate);

            expect(mocks.panelOpen).toHaveBeenCalledOnce();
            expect(mocks.claimSession).toHaveBeenCalledTimes(2);
            const secondGeneration = mocks.claimSession.mock.calls[1]?.[0].generation;
            expect(secondGeneration).not.toBe(firstGeneration);
            expect(mocks.clearSessionBinding).toHaveBeenCalledOnce();
            expect(mocks.clearSessionBinding).toHaveBeenCalledWith(secondGeneration);
            expect(secondDelegate).toHaveBeenCalledOnce();
        },
    );

    it("passes the stable provider identity to fallback after stash renumbering", async () => {
        const loadedStash = deferred<ProviderLoadResult>();
        const stash = provider("stash@{2}", { status: "over-budget", size: 99 }, "commit-oid");
        stash.load = vi.fn(async () => loadedStash.promise);
        let identities: { left?: string; right?: string } | undefined;
        const nativeDelegate = vi.fn(
            async (
                _token: { isCancellationRequested: boolean },
                providerIdentities: { left?: string; right?: string },
            ) => {
                identities = providerIdentities;
            },
        );

        const opening = openUnifiedDiff(request(stash), nativeDelegate);
        stash.label = "stash@{0}";
        loadedStash.resolve({ status: "over-budget", size: 99 });
        await opening;

        expect(identities).toEqual({ left: "commit-oid", right: "right" });
    });
});
