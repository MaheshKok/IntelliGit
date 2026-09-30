import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
    firstWindow: vi.fn(),
    waitForLoadState: vi.fn(),
    dismissFirstRunDialogs: vi.fn(),
    waitForE2eChannelReady: vi.fn(),
    close: vi.fn(),
}));

vi.mock("../../e2e/fixtureWorkspace", () => ({ expect }));
vi.mock("../../e2e/hostFixtures/resolveVSCodeExecutable", () => ({
    resolveVSCodeExecutable: vi.fn(async () => "/vscode"),
}));
vi.mock("../../e2e/hostFixtures/electronLaunchHelpers", () => ({
    launchFixtureWorkspace: vi.fn(async () => ({
        firstWindow: doubles.firstWindow,
        close: doubles.close,
    })),
    dismissFirstRunDialogs: doubles.dismissFirstRunDialogs,
}));
vi.mock("../../e2e/controlChannelClient", () => ({
    waitForE2eChannelReady: doubles.waitForE2eChannelReady,
}));

import type { FixtureWorkspaceFixture } from "../../e2e/fixtureWorkspace";
import { createFixtureWorkspace } from "../../fixtures/repo/harness";
import {
    launchPullFixture,
    prepareDirtyPull,
    pullFixtureGit,
} from "../../e2e/hostFixtures/pullLocalChanges";

describe("Pull fixture launch ownership", () => {
    const fixture = { workspace: {}, channelDir: "/channel" } as FixtureWorkspaceFixture;
    const page = { waitForLoadState: doubles.waitForLoadState };

    beforeEach(() => {
        vi.resetAllMocks();
        doubles.firstWindow.mockResolvedValue(page);
        doubles.close.mockResolvedValue(undefined);
    });

    it.each([
        "firstWindow",
        "waitForLoadState",
        "dismissFirstRunDialogs",
        "waitForE2eChannelReady",
    ] as const)(
        "closes the application when %s fails before returning its handle",
        async (step) => {
            const failure = new Error(`${step} failed`);
            doubles[step].mockRejectedValue(failure);

            await expect(launchPullFixture(fixture)).rejects.toBe(failure);
            expect(
                doubles.close,
                "a failed startup must not leak the launched application",
            ).toHaveBeenCalledOnce();
        },
    );

    it("preserves the initialization error when application cleanup also fails", async () => {
        const failure = new Error("channel unavailable");
        doubles.waitForE2eChannelReady.mockRejectedValue(failure);
        doubles.close.mockRejectedValue(new Error("close failed"));

        await expect(launchPullFixture(fixture)).rejects.toBe(failure);
        expect(doubles.close).toHaveBeenCalledOnce();
    });

    it("hands a successful launch to the caller without closing it", async () => {
        const launched = await launchPullFixture(fixture);
        expect(launched.page).toBe(page);
        expect(launched.app.close).toBe(doubles.close);
        expect(doubles.close).not.toHaveBeenCalled();
    });
});

describe("Pull fixture upstream preparation", () => {
    it.each(["unrelated", "missing"])(
        "advances main even when the remote default branch is %s",
        async (defaultBranch) => {
            const workspace = await createFixtureWorkspace({ scenario: "clean" });
            try {
                const git = (args: string[], cwd?: string) => pullFixtureGit(workspace, args, cwd);
                if (defaultBranch === "unrelated") {
                    git(["branch", "unrelated", "main"], workspace.originRoot);
                }
                git(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], workspace.originRoot);

                const prepared = await prepareDirtyPull(workspace);

                expect(git(["rev-parse", "main"], workspace.originRoot).trim()).toBe(
                    prepared.incomingHead,
                );
                expect(
                    git(["rev-parse", `${prepared.incomingHead}^`], workspace.originRoot).trim(),
                    "incoming changes must extend the newly seeded main tip",
                ).toBe(prepared.before.head.trim());
                expect(git(["symbolic-ref", "HEAD"], workspace.originRoot).trim()).toBe(
                    `refs/heads/${defaultBranch}`,
                );
            } finally {
                await workspace.dispose();
            }
        },
    );
});
