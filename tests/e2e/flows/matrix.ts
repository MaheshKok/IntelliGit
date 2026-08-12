import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
    expect,
    type FrameLocator,
    type Page,
} from "@playwright/test";

import type {
    FixtureScenarioId,
    FixtureWorkspace,
} from "../../fixtures/repo/harness";
import {
    DIRTY_FIXTURE,
    DIVERGENCE_FIXTURE,
    PUSHED_TIP_FIXTURE,
} from "../../fixtures/repo/scenarios";
import { FIXTURE_REFS } from "../../fixtures/repo/seed";
import type { FixtureWorkspaceFixture } from "../fixtureWorkspace";
import {
    dismissFirstRunDialogs,
    launchFixtureWorkspace,
} from "../hostFixtures/electronLaunchHelpers";
import { resolveVSCodeExecutable } from "../hostFixtures/resolveVSCodeExecutable";
import { ChangesPanel } from "../pageObjects/changesPanel";
import { IntelliGitView } from "../pageObjects/intelliGitView";
import { Workbench } from "../pageObjects/workbench";
import { oracles } from "../../oracles";
import type { GitStatusEntry } from "../oracles/localGit";

const { listFilesUnder, readDurableState } = oracles.get("durableState");
const localGit = oracles.get("localGit");
const origin = oracles.get("origin");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const COMMITTED_PATH = DIRTY_FIXTURE.mutablePath;
const COMMIT_MESSAGE = "phase 4 commit slice";
const CHECKOUT_BRANCH = "feature/awesome";
const DIRTY_VISIBLE_PATHS = DIRTY_FIXTURE.visiblePaths;
const SHELFED_PATH = "untracked.txt";
const SHELFED_CONTENT = "untracked content\n";
const {
    localAheadPath: LOCAL_AHEAD_PATH,
    localOnlySubject: LOCAL_ONLY_COMMIT_MESSAGE,
    originAdvancePath: ORIGIN_ADVANCE_PATH,
} = DIVERGENCE_FIXTURE;

/** The ten canonical flow IDs named by PLAN.md step 25. */
export const CANONICAL_FLOW_IDS = [
    "commit",
    "push",
    "pull",
    "interactive-rebase",
    "merge-conflict-resolve",
    "shelf-apply",
    "branch-checkout",
    "force-push-with-lease",
    "discard-changes",
    "abort-active-operation",
] as const;

/** The only flow IDs implemented by this slice; the remaining canonical rows are future work. */
export const IMPLEMENTED_FLOW_IDS = [
    "commit",
    "branch-checkout",
    "pull",
    "push",
    "interactive-rebase",
    "discard-changes",
    "shelf-apply",
    "abort-active-operation",
    "merge-conflict-resolve",
    "force-push-with-lease",
] as const;

type ImplementedFlowId = (typeof IMPLEMENTED_FLOW_IDS)[number];

/** State captured immediately before a row's action runs. */
export interface FlowBeforeState {
    readonly branch: string;
    readonly head: string;
    readonly originRef: string;
    readonly originHead: string;
    readonly status: readonly GitStatusEntry[];
}

/** Which IntelliGit webview surfaces a row drives. Rows that assert against the graph declare it
 * here so the panel is opened BEFORE the action: a frame created afterwards races the extension's
 * own reaction to the action, and a leg that dies on "Frame was detached" is a red that proves
 * nothing about the operation under test. */
type FlowSurface = "sidebar" | "graph-panel" | "sidebar-and-graph-panel";

/** Page objects and independent repository state available to one matrix row. */
interface FlowContext {
    readonly fixtureWorkspace: FixtureWorkspace;
    readonly page: Page;
    /** The surface named by the row: the sidebar, or the graph panel for a `graph-panel` row. */
    readonly frame: FrameLocator;
    /** The graph panel, present only for a `sidebar-and-graph-panel` row. */
    readonly graphFrame?: FrameLocator;
    readonly workbench: Workbench;
    readonly intelliGitView: IntelliGitView;
    readonly changesPanel: ChangesPanel;
    readonly before: FlowBeforeState;
}

/** A bespoke UI action or one of the four explicit oracle legs for a matrix row. */
type FlowStep = (context: FlowContext) => Promise<void>;

/** One checked-in flow row: scenario, action, UI oracle, local-git oracle, origin oracle, durable-state oracle. */
export interface FlowRow {
    readonly id: ImplementedFlowId;
    readonly scenario: FixtureScenarioId;
    /** Defaults to `sidebar`. */
    readonly surface?: FlowSurface;
    readonly action: FlowStep;
    readonly uiOracle: FlowStep;
    readonly localGitOracle: FlowStep;
    readonly originOracle: FlowStep;
    readonly durableStateOracle: FlowStep;
}

const CONFLICT_SESSION_MARKER = ".session-root";
const CONFLICT_SESSION_REVEAL_TIMEOUT_MS = 30_000;
const CONFLICT_SESSION_REVEAL_POLL_INTERVAL_MS = 250;

/** Finds IntelliGit's conflict-session webview by its rendered document marker, never by iframe order. */
async function revealConflictSession(page: Page): Promise<FrameLocator> {
    const deadline = Date.now() + CONFLICT_SESSION_REVEAL_TIMEOUT_MS;
    for (;;) {
        const outerFrames = await page.locator("iframe.webview").all();
        for (const outerFrame of outerFrames) {
            const inner = outerFrame.contentFrame().locator("iframe#active-frame").contentFrame();
            const count = await inner
                .locator(CONFLICT_SESSION_MARKER)
                .count()
                .catch(() => 0);
            if (count > 0) return inner;
        }
        if (Date.now() > deadline) {
            throw new Error(
                `No IntelliGit conflict-session webview rendered "${CONFLICT_SESSION_MARKER}" ` +
                    `within ${CONFLICT_SESSION_REVEAL_TIMEOUT_MS}ms.`,
            );
        }
        await page.waitForTimeout(CONFLICT_SESSION_REVEAL_POLL_INTERVAL_MS);
    }
}

/** Counts attached IntelliGit conflict-session documents so a resolved panel can be proven closed. */
async function countConflictSessionFrames(page: Page): Promise<number> {
    const outerFrames = await page.locator("iframe.webview").all();
    let count = 0;
    for (const outerFrame of outerFrames) {
        const inner = outerFrame.contentFrame().locator("iframe#active-frame").contentFrame();
        count += await inner
            .locator(CONFLICT_SESSION_MARKER)
            .count()
            .catch(() => 0);
    }
    return count;
}

export async function captureBeforeState(workspace: FixtureWorkspace): Promise<FlowBeforeState> {
    const [branch, head, status] = await Promise.all([
        localGit.currentBranch(workspace),
        localGit.headOid(workspace),
        localGit.statusPorcelain(workspace),
    ]);
    // During `mid-rebase`, Git deliberately detaches HEAD while the conflict is live, so there is
    // no branch name to form an origin ref from. The fixture's only published branch is the seeded
    // main ref; using it for this negative origin leg preserves a real before/after comparison
    // without inventing an upstream for the detached rebase state.
    const originRef = `refs/heads/${branch || FIXTURE_REFS.main}`;
    return {
        branch,
        head,
        originRef,
        originHead: await origin.refOid(workspace, originRef),
        status,
    };
}

/** Asserts the durable stores are clean after a row, retaining all checks when one leg fails. */
async function assertDurableStateClean(context: FlowContext): Promise<void> {
    const durableState = await readDurableState(context.fixtureWorkspace);
    const globalStorageIsDirectory = await stat(durableState.globalStoragePath)
        .then((details) => details.isDirectory())
        .catch(() => false);
    expect.soft(globalStorageIsDirectory).toBe(true);
    expect.soft(durableState.shelfStoreFiles).toEqual([]);
    expect
        .soft(durableState.rebaseManifestFiles, "rebase manifest storage must be empty after the flow")
        .toEqual([]);
    // Polled, not sampled, for the same reason as the shelf lock below: `releaseCallback` in
    // `src/git/repositoryLock.ts` awaits every owed heartbeat write before unlinking, so the lock
    // can outlive the UI signal the row waited on. Sampling it once produced a real intermittent
    // red on `shelf-apply`. A release still in flight clears within the timeout; a lock that is
    // genuinely leaked stays and still fails.
    //
    // This leg is NOT row-provable, and is kept for the leak it would catch rather than claimed as
    // proven. Both reachable mutations were measured against this build: skipping the `rm` at
    // `repositoryLock.ts:134` kills the row upstream in fixture setup
    // (`RepositoryLockBusyError` at `repositoryLock.ts:73`, via `prepareShelfPopulated`), so the
    // flow never runs; and dropping the `await pendingWrite` drain -- the documented late-write
    // bug the chaining exists to prevent -- is inert here, because the heartbeat interval is 5s and
    // these flows finish well inside one tick, so no write is ever in flight to land after the rm.
    await expect
        .poll(async () => (await readDurableState(context.fixtureWorkspace)).repoLockPresent, {
            message: "repository lock must be released, not leaked, after the flow",
        })
        .toBe(false);
    expect.soft(durableState.takeoverPaths).toEqual([]);
    // The shelf lock is excluded from `shelfStoreFiles` because it is transient, so it is asserted
    // here instead -- by polling, not by sampling. A lock still held by an in-flight refresh
    // releases within the timeout; one that is genuinely leaked never does and fails the leg.
    // The message is load-bearing: `runOracleLeg` funnels every leg failure through one catch, so
    // without it a poll timeout is indistinguishable from a crash in the same leg.
    await expect
        .poll(async () => (await listFilesUnder(durableState.shelfLockDirectory)).length, {
            message: "shelf store lock must be released, not leaked, after the flow",
        })
        .toBe(0);
}

/** Asserts the shelf ghost remains durable while the other extension-owned stores are clean. */
async function assertShelfApplyDurableState(context: FlowContext): Promise<void> {
    const shelfStorageRoot = context.fixtureWorkspace.shelfStorageRoot;
    if (shelfStorageRoot === undefined) {
        expect
            .soft(shelfStorageRoot, "shelf-populated must expose its seeded shelf storage root")
            .toBeDefined();
        return;
    }

    const durableState = await readDurableState(context.fixtureWorkspace, {
        globalStoragePath: shelfStorageRoot,
    });
    const globalStorageIsDirectory = await stat(durableState.globalStoragePath)
        .then((details) => details.isDirectory())
        .catch(() => false);
    const shelfFiles = durableState.shelfStoreFiles;
    expect.soft(globalStorageIsDirectory).toBe(true);
    // The applied entry is a ghost, not a deleted shelf: catalog, current pointer, immutable
    // manifest/object bytes, and the terminal ghost journal are all load-bearing store evidence.
    expect.soft(durableState.shelfRoot).toContain(path.join(shelfStorageRoot, "shelves"));
    expect.soft(shelfFiles.some((file) => file.endsWith(path.join("catalog.json")))).toBe(true);
    expect.soft(shelfFiles.some((file) => file.endsWith(path.join("current")))).toBe(true);
    expect.soft(shelfFiles.some((file) => file.endsWith(path.join("manifest.json")))).toBe(true);
    expect.soft(shelfFiles.some((file) => file.split(path.sep).includes("objects"))).toBe(true);
    expect.soft(shelfFiles.some((file) => file.split(path.sep).includes("journals"))).toBe(true);
    expect.soft(durableState.rebaseManifestFiles).toEqual([]);
    // Polled for the same release race described in `assertDurableStateClean`.
    await expect
        .poll(
            async () =>
                (
                    await readDurableState(context.fixtureWorkspace, {
                        globalStoragePath: shelfStorageRoot,
                    })
                ).repoLockPresent,
            { message: "repository lock must be released, not leaked, after the flow" },
        )
        .toBe(false);
    expect.soft(durableState.takeoverPaths).toEqual([]);
}

/** Runs one oracle leg without allowing a runtime assertion error to suppress later legs. */
async function runOracleLeg(label: string, oracle: FlowStep, context: FlowContext): Promise<void> {
    try {
        await oracle(context);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect.soft(false, `${label} oracle failed: ${message}`).toBe(true);
    }
}

/** Executes one matrix row and reports every oracle leg even when an earlier leg is red. */
export async function runFlow(flow: FlowRow, fixture: FixtureWorkspaceFixture): Promise<void> {
    const fixtureWorkspace = fixture.workspace;
    const executablePath = await resolveVSCodeExecutable(REPO_ROOT);
    const electronApp = await launchFixtureWorkspace({
        executablePath,
        repoRoot: REPO_ROOT,
        workspace: fixtureWorkspace,
        channelDir: fixture.channelDir,
        timeout: 60_000,
    });

    try {
        const page = await electronApp.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        await dismissFirstRunDialogs(page);
        const workbench = new Workbench(page);
        const intelliGitView = new IntelliGitView(page);
        const surface = flow.surface ?? "sidebar";
        // The graph panel opens first in both cases that need it: revealing the sidebar afterwards
        // leaves the editor webview attached, whereas opening the panel later would create a frame
        // while the extension is still reacting to the row's action.
        const graphFrame =
            surface === "sidebar"
                ? undefined
                : await workbench
                      .runCommand("IntelliGit: Show Git Log")
                      .then(() => intelliGitView.revealPanel());
        const frame =
            surface === "graph-panel" && graphFrame !== undefined
                ? graphFrame
                : await intelliGitView.reveal();
        const context: FlowContext = {
            fixtureWorkspace,
            page,
            frame,
            graphFrame: surface === "sidebar-and-graph-panel" ? graphFrame : undefined,
            workbench,
            intelliGitView,
            changesPanel: new ChangesPanel(frame),
            before: await captureBeforeState(fixtureWorkspace),
        };

        let actionError: unknown;
        try {
            await flow.action(context);
        } catch (error) {
            actionError = error;
        }

        await runOracleLeg("UI", flow.uiOracle, context);
        await runOracleLeg("local-git", flow.localGitOracle, context);
        await runOracleLeg("origin", flow.originOracle, context);
        await runOracleLeg("durable-state", flow.durableStateOracle, context);

        if (actionError !== undefined) throw actionError;
    } finally {
        await electronApp.close();
    }
}

/** The only runnable flow definitions for this slice. Later canonical rows are intentionally absent. */
export const FLOW_MATRIX: readonly FlowRow[] = [
    {
        id: "commit",
        scenario: "dirty",
        action: async ({ page, workbench, changesPanel }) => {
            const panel = page.locator(".part.panel");
            const panelBefore = await panel.isVisible();
            await workbench.runCommand("View: Toggle Panel");
            await expect.poll(() => panel.isVisible()).toBe(!panelBefore);
            await workbench.runCommand("View: Toggle Panel");
            await expect.poll(() => panel.isVisible()).toBe(panelBefore);
            await expect(changesPanel.changedFileRow(COMMITTED_PATH)).toBeVisible();
            await changesPanel.stagePath(COMMITTED_PATH);
            await changesPanel.typeCommitMessage(COMMIT_MESSAGE);
            await changesPanel.commit();
        },
        uiOracle: async ({ changesPanel }) => {
            await expect.soft(changesPanel.changedFileRow(COMMITTED_PATH)).toHaveCount(0);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            const [localHeadSubject, localHead, localHeadParents, localStatus] = await Promise.all([
                localGit.headSubject(fixtureWorkspace),
                localGit.headOid(fixtureWorkspace),
                localGit.headParentOids(fixtureWorkspace),
                localGit.statusPorcelain(fixtureWorkspace),
            ]);
            const beforeOtherStatus = before.status.filter(
                (entry) => entry.path !== COMMITTED_PATH,
            );
            expect.soft(localHeadSubject).toBe(COMMIT_MESSAGE);
            expect.soft(localHead).not.toBe(before.head);
            expect.soft(localHeadParents).toEqual([before.head]);
            expect.soft(localStatus.some((entry) => entry.path === COMMITTED_PATH)).toBe(false);
            expect
                .soft(localStatus.filter((entry) => entry.path !== COMMITTED_PATH))
                .toEqual(beforeOtherStatus);
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const originAfter = await origin.refOid(fixtureWorkspace, before.originRef);
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(false);
            expect.soft(originAfter).toBe(before.originHead);
        },
        durableStateOracle: assertDurableStateClean,
    },
    {
        id: "branch-checkout",
        scenario: "clean",
        surface: "graph-panel",
        action: async ({ frame, workbench }) => {
            await workbench.checkoutBranch(frame, CHECKOUT_BRANCH);
        },
        uiOracle: async ({ frame }) => {
            await expect
                .soft(frame.getByRole("button", { name: `HEAD (${CHECKOUT_BRANCH})`, exact: true }))
                .toHaveCount(1);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            expect.soft(before.status).toEqual([]);
            const [currentBranch, localHead, featureHead, localStatus] = await Promise.all([
                localGit.currentBranch(fixtureWorkspace),
                localGit.headOid(fixtureWorkspace),
                localGit.refOid(fixtureWorkspace, `refs/heads/${CHECKOUT_BRANCH}`),
                localGit.statusPorcelain(fixtureWorkspace),
            ]);
            expect.soft(currentBranch).toBe(CHECKOUT_BRANCH);
            expect.soft(localHead).toBe(featureHead);
            expect.soft(before.branch).toBe("main");
            expect
                .soft(localStatus.map((entry) => entry.path))
                .toEqual(before.status.map((entry) => entry.path));
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const originAfter = await origin.refOid(fixtureWorkspace, before.originRef);
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(false);
            expect.soft(originAfter).toBe(before.originHead);
        },
        durableStateOracle: assertDurableStateClean,
    },
    {
        id: "pull",
        scenario: "ahead-behind",
        surface: "sidebar-and-graph-panel",
        action: async ({ frame, fixtureWorkspace, before }) => {
            await frame
                .getByTestId("commit-panel-tab-row")
                .getByRole("button", { name: "Pull", exact: true })
                .click();
            await expect
                .poll(() => localGit.headOid(fixtureWorkspace))
                .not.toBe(before.head);
        },
        uiOracle: async ({ frame, graphFrame }) => {
            const toolbar = frame.getByTestId("commit-panel-tab-row");
            await expect.soft(toolbar.getByRole("button", { name: "Pull", exact: true })).toHaveCount(
                1,
            );
            if (graphFrame === undefined) throw new Error("The pull row requires the graph panel.");
            // Deliberately NOT `push-ahead-count`: on `ahead-behind` the branch is ahead 1 both
            // before and after the rebase, so that element reads "↑1" whether the pull integrated
            // origin's commit or failed outright -- a leg that cannot fail for the reason this row
            // exists. Nor the pulled commit's subject in the commit list: that list is built from
            // `git log --all` (`operations.ts` getCommits), so `origin/main` renders "Advance origin
            // main" whether or not local `main` ever merged it -- mutation-checked, the assertion
            // stayed green under a broken pull. What the pull genuinely clears is the branch
            // column's INCOMING-commits badge (`BranchTreeNodeRow.tsx` TrackingBadge).
            //
            // Both halves below are load-bearing and neither can be dropped: incoming must be gone
            // (the pull integrated origin's commit) AND outgoing must still be rendered (the branch
            // column drew its tracking badges at all). Asserting only the zero would go green on a
            // branch column that rendered no badges whatsoever.
            await expect.soft(graphFrame.locator(".branch-track-pull")).toHaveCount(0);
            await expect.soft(graphFrame.locator(".branch-track-push")).toHaveCount(1);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            const [localHead, localHeadParents, localHeadSubject, treePaths, localStatus] =
                await Promise.all([
                    localGit.headOid(fixtureWorkspace),
                    localGit.headParentOids(fixtureWorkspace),
                    localGit.headSubject(fixtureWorkspace),
                    localGit.headTreePaths(fixtureWorkspace),
                    localGit.statusPorcelain(fixtureWorkspace),
                ]);
            expect.soft(localHead).not.toBe(before.head);
            expect.soft(localHeadParents[0]).toBe(before.originHead);
            expect.soft(localHeadSubject).toBe(LOCAL_ONLY_COMMIT_MESSAGE);
            expect.soft(treePaths).toEqual(
                expect.arrayContaining([LOCAL_AHEAD_PATH, ORIGIN_ADVANCE_PATH]),
            );
            expect.soft(localStatus).toEqual([]);
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const originAfter = await origin.refOid(fixtureWorkspace, before.originRef);
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(false);
            expect.soft(originAfter).toBe(before.originHead);
        },
        durableStateOracle: assertDurableStateClean,
    },
    {
        id: "push",
        scenario: "ahead-only",
        action: async ({ frame, fixtureWorkspace, before }) => {
            await expect(frame.getByTestId("push-ahead-count")).toHaveText("↑1");
            await frame
                .getByTestId("commit-panel-tab-row")
                .getByRole("button", { name: "Push", exact: true })
                .click();
            await expect
                .poll(() => origin.refOid(fixtureWorkspace, before.originRef))
                .not.toBe(before.originHead);
        },
        uiOracle: async ({ frame }) => {
            const toolbar = frame.getByTestId("commit-panel-tab-row");
            await expect.soft(toolbar.getByRole("button", { name: "Push", exact: true })).toHaveCount(
                1,
            );
            await expect.soft(frame.getByTestId("push-ahead-count")).toHaveCount(0);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            const [localHead, localHeadSubject, treePaths, counts, localStatus, originWasAncestor] =
                await Promise.all([
                    localGit.headOid(fixtureWorkspace),
                    localGit.headSubject(fixtureWorkspace),
                    localGit.headTreePaths(fixtureWorkspace),
                    localGit.aheadBehindCounts(fixtureWorkspace),
                    localGit.statusPorcelain(fixtureWorkspace),
                    localGit.isAncestor(fixtureWorkspace, before.originHead, before.head),
                ]);
            expect.soft(localHead).toBe(before.head);
            expect.soft(localHeadSubject).toBe(LOCAL_ONLY_COMMIT_MESSAGE);
            expect.soft(treePaths).toContain(LOCAL_AHEAD_PATH);
            expect.soft(counts).toEqual({ ahead: 0, behind: 0 });
            expect.soft(originWasAncestor).toBe(true);
            expect.soft(localStatus).toEqual(before.status);
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const [originAfter, localHead] = await Promise.all([
                origin.refOid(fixtureWorkspace, before.originRef),
                localGit.headOid(fixtureWorkspace),
            ]);
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(true);
            expect.soft(originAfter).toBe(localHead);
        },
        durableStateOracle: assertDurableStateClean,
    },
    {
        id: "interactive-rebase",
        scenario: "ahead-only",
        surface: "graph-panel",
        action: async ({ frame, page }) => {
            const localAheadCommit = frame
                .getByRole("button")
                .filter({ hasText: DIVERGENCE_FIXTURE.localOnlySubject });
            await expect(localAheadCommit).toHaveCount(1);
            await localAheadCommit.click({ button: "right" });

            const menu = frame.getByRole("menu");
            await menu
                .getByRole("menuitem", {
                    name: "Interactively Rebase from Here...",
                    exact: true,
                })
                .press("Enter");

            const rebaseDialog = frame.getByRole("dialog", { name: "Rebasing Commits" });
            await expect(rebaseDialog).toBeVisible();
            await rebaseDialog
                .getByRole("combobox", { name: "Rebase action", exact: true })
                .selectOption("reword");
            await rebaseDialog
                .getByRole("textbox", { name: "Commit message", exact: true })
                .fill(DIVERGENCE_FIXTURE.rewordedSubject);
            await rebaseDialog
                .getByRole("button", { name: "Start Rebasing", exact: true })
                .click();
            await expect
                .poll(() =>
                    page
                        .getByRole("alert")
                        .filter({ hasText: "Interactive rebase completed." })
                        .count(),
                )
                .toBe(1);
        },
        uiOracle: async ({ frame, page }) => {
            await expect
                .soft(frame.getByRole("dialog", { name: "Rebasing Commits" }))
                .toHaveCount(0);
            await expect
                .soft(frame.getByText(DIVERGENCE_FIXTURE.rewordedSubject, { exact: true }))
                .toHaveCount(1);
            await expect
                .soft(page.getByRole("alert").filter({ hasText: "Interactive rebase completed." }))
                .toHaveCount(1);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            const [currentBranch, localHead, localHeadParents, localHeadSubject, treePaths, counts, localStatus] =
                await Promise.all([
                    localGit.currentBranch(fixtureWorkspace),
                    localGit.headOid(fixtureWorkspace),
                    localGit.headParentOids(fixtureWorkspace),
                    localGit.headSubject(fixtureWorkspace),
                    localGit.headTreePaths(fixtureWorkspace),
                    localGit.aheadBehindCounts(fixtureWorkspace),
                    localGit.statusPorcelain(fixtureWorkspace),
                ]);
            expect.soft(before.branch).toBe(FIXTURE_REFS.main);
            expect.soft(currentBranch).toBe(FIXTURE_REFS.main);
            expect.soft(localHead).not.toBe(before.head);
            expect.soft(localHeadParents).toHaveLength(1);
            expect.soft(localHeadSubject).toBe(DIVERGENCE_FIXTURE.rewordedSubject);
            expect.soft(treePaths).toContain(DIVERGENCE_FIXTURE.localAheadPath);
            expect.soft(counts).toEqual({ ahead: 1, behind: 0 });
            expect.soft(localStatus).toEqual([]);
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const originAfter = await origin.refOid(fixtureWorkspace, before.originRef);
            // Both halves are retained: the reword is local-only, so origin must stay byte-for-byte
            // unchanged, and equality to the captured ref proves the oracle read the intended branch.
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(false);
            expect.soft(originAfter).toBe(before.originHead);
        },
        // Row-proven: disabling the `shouldDeleteManifest` cleanup at
        // `src/git/interactiveRebase/run.ts:211` reds this leg at the rebase-manifest assertion.
        durableStateOracle: assertDurableStateClean,
    },
    {
        id: "discard-changes",
        scenario: "dirty",
        action: async ({ frame, page, changesPanel }) => {
            await expect(changesPanel.changedFileRow(DIRTY_FIXTURE.mutablePath)).toBeVisible();
            await frame.getByRole("button", { name: "Rollback", exact: true }).click();
            // This is the workbench DOM for IntelliGit's own showWarningMessage modal, not a
            // browser-native dialog and not a built-in Git surface. The message assertion is
            // load-bearing: it proves the empty-selection rollbackFromPanel branch was reached
            // before the destructive operation, rather than merely finding a generic dialog.
            const dialog = page.locator(".monaco-dialog-box");
            await expect(dialog).toBeVisible();
            await expect(dialog).toContainText("Rollback all changes?");
            await dialog.getByRole("button", { name: "Rollback", exact: true }).click();
        },
        uiOracle: async ({ frame }) => {
            const commitTab = frame.getByTestId("commit-tab");
            // Every visible dirty class must disappear: tracked staged+unstaged, untracked text,
            // staged binary, CRLF untracked, and staged rename. Ignored/build.log is intentionally
            // not listed because `rollbackAll` uses `clean -fd`, so Git status remains clean while
            // the ignored file survives.
            for (const repositoryPath of DIRTY_VISIBLE_PATHS) {
                await expect.soft(frame.getByTitle(repositoryPath)).toHaveCount(0);
            }
            // The disappearance assertions prove the result only when the tree rendered; the
            // toolbar's surviving Rollback button proves the commit panel itself did not vanish.
            await expect.soft(commitTab).toBeVisible();
            await expect
                .soft(commitTab.getByRole("button", { name: "Rollback", exact: true }))
                .toHaveCount(1);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            expect.soft(before.status.length).toBeGreaterThan(0);
            const visibleStatusEntries = before.status.filter((entry) =>
                DIRTY_VISIBLE_PATHS.some((repositoryPath) => repositoryPath === entry.path),
            );
            // Both checks are load-bearing: the count prevents an empty or duplicated source list
            // from making membership vacuously pass, while membership proves every named fixture path
            // really existed in the pre-action porcelain snapshot, including the rename destination.
            expect.soft(visibleStatusEntries).toHaveLength(DIRTY_VISIBLE_PATHS.length);
            expect.soft(before.status.map((entry) => entry.path)).toEqual(
                expect.arrayContaining([...DIRTY_VISIBLE_PATHS]),
            );
            const [localHead, localStatus] = await Promise.all([
                localGit.headOid(fixtureWorkspace),
                localGit.statusPorcelain(fixtureWorkspace),
            ]);
            expect.soft(localHead).toBe(before.head);
            expect.soft(localStatus).toEqual([]);
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const originAfter = await origin.refOid(fixtureWorkspace, before.originRef);
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(false);
            expect.soft(originAfter).toBe(before.originHead);
        },
        durableStateOracle: assertDurableStateClean,
    },
    {
        id: "shelf-apply",
        scenario: "shelf-populated",
        action: async ({ frame, fixtureWorkspace }) => {
            const shelfTab = frame.getByRole("tab", { name: /^Shelf(?: \(\d+\))?$/ });
            await shelfTab.click();
            const shelfList = frame.getByTestId("shelf-list");
            await expect(frame.getByTestId("shelf-tab")).toBeVisible();
            await expect(shelfList).toBeVisible();
            const seededShelf = shelfList
                .getByRole("treeitem")
                .filter({ hasText: "scenario-seeded-shelf" });
            // The seeded shelf must be visible in IntelliGit's own pane before selecting its menu.
            await expect(seededShelf).toHaveCount(1);
            await seededShelf.click({ button: "right" });
            const shelfMenu = frame.getByRole("menu");
            await expect(
                shelfMenu.getByRole("menuitem", { name: /^Unshelve(?:…|\.\.\.)/ }),
            ).toBeVisible();
            await shelfMenu
                .getByRole("menuitem", { name: /^Unshelve(?:…|\.\.\.)/ })
                .click();

            const unshelveDialog = frame.getByRole("dialog");
            await expect(unshelveDialog.getByRole("heading", { name: "Unshelve", exact: true })).toBeVisible();
            await expect(
                unshelveDialog.getByRole("checkbox", { name: SHELFED_PATH, exact: true }),
            ).toBeChecked();
            await unshelveDialog.getByRole("button", { name: "Unshelve", exact: true }).click();
            await expect
                .poll(() =>
                    readFile(path.join(fixtureWorkspace.root, SHELFED_PATH), "utf8").catch(() => null),
                )
                .toBe(SHELFED_CONTENT);

            // Default remove-on-unshelve retains an applied ghost; make that production state
            // visible through IntelliGit's own Shelf toolbar before the UI oracle inspects it.
            await frame
                .getByTestId("shelf-toolbar")
                .getByRole("button", { name: "More Options", exact: true })
                .click();
            await frame
                .getByRole("menu")
                .getByRole("menuitem", { name: "Show Already Unshelved", exact: true })
                .click();

            // Keep the fixture field consumed by the action path as well as the durable oracle: the
            // launched extension and this independent read must observe the same seeded root.
            await expect(
                readFile(path.join(fixtureWorkspace.root, SHELFED_PATH), "utf8"),
            ).resolves.toBe(SHELFED_CONTENT);
        },
        uiOracle: async ({ frame }) => {
            const shelfTab = frame.getByTestId("shelf-tab");
            // The shelf pane/list are positive render evidence; without them an empty list could
            // pass for a successfully removed shelf because the webview never rendered.
            await expect.soft(shelfTab).toBeVisible();
            await expect.soft(shelfTab.getByTestId("shelf-toolbar")).toHaveCount(1);
            await expect.soft(shelfTab.getByTestId("shelf-list")).toBeVisible();
            const ghost = shelfTab
                .locator('[role="treeitem"][data-ghost="true"]')
                .filter({ hasText: "scenario-seeded-shelf" });
            await expect.soft(ghost).toHaveCount(1);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            expect.soft(before.status.length).toBeGreaterThan(0);
            expect.soft(before.status.some((entry) => entry.path === SHELFED_PATH)).toBe(false);
            const [localHead, localStatus, shelvedContent] = await Promise.all([
                localGit.headOid(fixtureWorkspace),
                localGit.statusPorcelain(fixtureWorkspace),
                readFile(path.join(fixtureWorkspace.root, SHELFED_PATH), "utf8"),
            ]);
            expect.soft(localHead).toBe(before.head);
            expect.soft(localStatus).toEqual(
                expect.arrayContaining([
                    { indexStatus: "?", worktreeStatus: "?", path: SHELFED_PATH },
                ]),
            );
            expect.soft(shelvedContent).toBe(SHELFED_CONTENT);
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const originAfter = await origin.refOid(fixtureWorkspace, before.originRef);
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(false);
            expect.soft(originAfter).toBe(before.originHead);
        },
        durableStateOracle: assertShelfApplyDurableState,
    },
    {
        id: "abort-active-operation",
        scenario: "mid-rebase",
        action: async ({ frame }) => {
            const abortButton = frame.getByRole("button", { name: "Abort Rebase", exact: true });
            await expect(abortButton).toBeVisible();
            // `mid-rebase` is started by Git, not IntelliGit, so this is the pass-through branch:
            // production dispatches `git rebase --abort` directly and intentionally raises no modal.
            await abortButton.click();
        },
        uiOracle: async ({ frame, page }) => {
            const commitPanel = frame.getByTestId("commit-panel-tab-row");
            // Both rebase controls must disappear: the panel must still render, AND neither action
            // may remain advertised after Git clears the live rebase state.
            await expect.soft(commitPanel).toBeVisible();
            await expect
                .soft(frame.getByRole("button", { name: "Continue Rebase", exact: true }))
                .toHaveCount(0);
            await expect
                .soft(frame.getByRole("button", { name: "Abort Rebase", exact: true }))
                .toHaveCount(0);
            await expect
                .soft(page.getByRole("alert").filter({ hasText: "Interactive rebase aborted." }))
                .toHaveCount(1);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            const [currentBranch, localHead, restoredHead, localStatus] = await Promise.all([
                localGit.currentBranch(fixtureWorkspace),
                localGit.headOid(fixtureWorkspace),
                localGit.refOid(fixtureWorkspace, `refs/heads/${FIXTURE_REFS.conflicting}`),
                localGit.statusPorcelain(fixtureWorkspace),
            ]);
            const hadUnmergedEntry = before.status.some(
                (entry) => entry.indexStatus === "U" || entry.worktreeStatus === "U",
            );
            // The fixture is detached only while rebase is live; these checks jointly prove that the
            // pass-through abort restored the original branch tip and removed the conflict, rather
            // than merely refreshing a webview after a failed command.
            expect.soft(before.branch).toBe("");
            expect.soft(hadUnmergedEntry).toBe(true);
            expect.soft(currentBranch).toBe(FIXTURE_REFS.conflicting);
            expect.soft(localHead).toBe(restoredHead);
            expect.soft(localHead).not.toBe(before.head);
            expect.soft(localStatus).toEqual([]);
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const originAfter = await origin.refOid(fixtureWorkspace, before.originRef);
            // This row never invokes a push; both assertions retain the captured ref identity and
            // prove the abort did not mutate the fixture's independent bare origin.
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(false);
            expect.soft(originAfter).toBe(before.originHead);
        },
        // Verdict: by-construction against the fixed oracle. `mid-rebase` is a pass-through rebase,
        // and `abortPassThroughRebase` only shells out to `git rebase --abort`; it never writes a
        // manifest, so `rebaseManifestFiles` is empty independently of completion cleanup. The
        // shared assertion remains a leak detector for the repo lock and takeover markers.
        durableStateOracle: assertDurableStateClean,
    },
    {
        id: "merge-conflict-resolve",
        scenario: "conflicted",
        action: async ({ page, workbench }) => {
            // Drive IntelliGit's registered command so the production path creates its own
            // `merge-conflict-session` webview; the VS Code built-in merge editor is out of scope.
            await workbench.runCommand("Open Conflict Session");
            const conflictSession = await revealConflictSession(page);
            await expect(conflictSession.locator("tbody tr.row")).toHaveCount(1);
            const acceptYours = conflictSession.getByRole("button", {
                name: "Accept Yours",
                exact: true,
            });
            await expect(acceptYours).toBeEnabled();
            await acceptYours.click();
            await expect
                .poll(() =>
                    page
                        .getByRole("alert")
                        .filter({ hasText: "All merge conflicts are resolved." })
                        .count(),
                )
                .toBe(1);
        },
        uiOracle: async ({ page }) => {
            // The production panel emits this workbench notification only after its own session
            // refresh sees zero conflict files; it is positive evidence for the rendered panel plus
            // the Accept Yours action, not a disappearance-only assertion on a detached webview.
            await expect
                .soft(page.getByRole("alert").filter({ hasText: "All merge conflicts are resolved." }))
                .toHaveCount(1);
            expect.soft(await countConflictSessionFrames(page)).toBe(0);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            const unresolvedBefore = before.status.filter(
                (entry) => entry.indexStatus === "U" || entry.worktreeStatus === "U",
            );
            const unresolvedPaths = [...new Set(unresolvedBefore.map((entry) => entry.path))];
            const [currentBranch, localHead, localStatus, mergeHead, resolvedContents, headContents] =
                await Promise.all([
                    localGit.currentBranch(fixtureWorkspace),
                    localGit.headOid(fixtureWorkspace),
                    localGit.statusPorcelain(fixtureWorkspace),
                    readFile(path.join(fixtureWorkspace.root, ".git", "MERGE_HEAD"), "utf8").catch(
                        () => null,
                    ),
                    Promise.all(
                        unresolvedPaths.map((repositoryPath) =>
                            readFile(path.join(fixtureWorkspace.root, repositoryPath), "utf8").catch(
                                () => null,
                            ),
                        ),
                    ),
                    Promise.all(
                        unresolvedPaths.map((repositoryPath) =>
                            localGit.headPathContent(fixtureWorkspace, repositoryPath).catch(
                                () => null,
                            ),
                        ),
                    ),
                ]);
            // The count prevents a clean/empty fixture from making the per-path checks vacuous.
            expect.soft(unresolvedPaths.length).toBeGreaterThan(0);
            expect.soft(currentBranch).toBe(FIXTURE_REFS.main);
            expect.soft(localHead).toBe(before.head);
            expect.soft(mergeHead).not.toBeNull();
            expect
                .soft(localStatus.some((entry) => entry.indexStatus === "U" || entry.worktreeStatus === "U"))
                .toBe(false);
            // Accept Yours can legitimately produce a clean worktree when ours already equals
            // HEAD; if it differs, Git reports the resolved path as staged M. In either case every
            // remaining status entry must belong to the conflict set and be a staged resolution.
            expect.soft(localStatus.every((entry) => unresolvedPaths.includes(entry.path))).toBe(true);
            expect
                .soft(localStatus.every((entry) => entry.indexStatus === "M" && entry.worktreeStatus === " "))
                .toBe(true);
            expect.soft(resolvedContents.every((content) => content !== null)).toBe(true);
            expect.soft(headContents.every((content) => content !== null)).toBe(true);
            for (let index = 0; index < resolvedContents.length; index += 1) {
                const content = resolvedContents[index];
                const headContent = headContents[index];
                if (content !== null) expect.soft(content).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
                if (content !== null && headContent !== null) expect.soft(content).toBe(headContent);
            }
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const originAfter = await origin.refOid(fixtureWorkspace, before.originRef);
            // Resolving and staging a conflict is local-only; the independent origin must remain
            // byte-for-byte unchanged until a later commit/push flow explicitly publishes it.
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(false);
            expect.soft(originAfter).toBe(before.originHead);
        },
        // Verdict: by-construction against the fixed oracle. Resolving a conflict through the
        // session panel writes no shelf entry, rebase manifest, or takeover marker, so those durable
        // fields remain empty on this path; the shared assertion still detects an unexpected leak.
        durableStateOracle: assertDurableStateClean,
    },
    {
        id: "force-push-with-lease",
        scenario: "pushed-tip",
        surface: "graph-panel",
        action: async ({ frame, page }) => {
            const pushedTipCommit = frame
                .getByRole("button")
                .filter({ hasText: PUSHED_TIP_FIXTURE.subject });
            await expect(pushedTipCommit).toHaveCount(1);
            await pushedTipCommit.click({ button: "right" });

            const menu = frame.getByRole("menu");
            await menu
                .getByRole("menuitem", {
                    name: "Interactively Rebase from Here...",
                    exact: true,
                })
                .press("Enter");

            const rebaseDialog = frame.getByRole("dialog", { name: "Rebasing Commits" });
            await expect(rebaseDialog).toBeVisible();
            await expect(rebaseDialog.getByRole("alert")).toContainText(
                "Some commits have already been pushed. Rebasing them rewrites published history.",
            );
            await rebaseDialog
                .getByRole("combobox", { name: "Rebase action", exact: true })
                .selectOption("reword");
            await rebaseDialog
                .getByRole("textbox", { name: "Commit message", exact: true })
                .fill(PUSHED_TIP_FIXTURE.rewordedSubject);
            await rebaseDialog
                .getByRole("button", { name: "Start Rebasing", exact: true })
                .click();

            // This targets IntelliGit's workbench notification toast in the workbench DOM, not a
            // browser-native dialog, modal container, or webview dialog. The exact message proves
            // the completed-pending-push branch before the destructive action is accepted.
            const notification = page
                .locator(".notifications-toasts")
                .locator(".notification-toast")
                .filter({
                    hasText: "Interactive rebase completed. Force-push the rewritten commits?",
                });
            await expect(notification).toBeVisible();
            await expect(notification).toContainText(
                "Interactive rebase completed. Force-push the rewritten commits?",
            );
            await notification.getByRole("button", { name: "Force Push", exact: true }).click();
            await expect
                .poll(() =>
                    page.getByRole("alert").filter({ hasText: "Force push completed." }).count(),
                )
                .toBe(1);
        },
        uiOracle: async ({ frame, page }) => {
            await expect
                .soft(frame.getByRole("dialog", { name: "Rebasing Commits" }))
                .toHaveCount(0);
            await expect
                .soft(frame.getByText(PUSHED_TIP_FIXTURE.rewordedSubject, { exact: true }))
                .toHaveCount(1);
            await expect
                .soft(page.getByRole("alert").filter({ hasText: "Force push completed." }))
                .toHaveCount(1);
        },
        localGitOracle: async ({ fixtureWorkspace, before }) => {
            const [currentBranch, localHead, localHeadParents, localHeadSubject, counts, localStatus] =
                await Promise.all([
                    localGit.currentBranch(fixtureWorkspace),
                    localGit.headOid(fixtureWorkspace),
                    localGit.headParentOids(fixtureWorkspace),
                    localGit.headSubject(fixtureWorkspace),
                    localGit.aheadBehindCounts(fixtureWorkspace),
                    localGit.statusPorcelain(fixtureWorkspace),
                ]);
            // `aheadBehindCounts` hardcodes `main...@{upstream}`; these checks prove this settled
            // scenario keeps `main` checked out and that the force push updated its upstream.
            expect.soft(before.branch).toBe(FIXTURE_REFS.main);
            expect.soft(currentBranch).toBe(FIXTURE_REFS.main);
            expect.soft(localHead).not.toBe(before.head);
            expect.soft(localHeadParents).toHaveLength(1);
            expect.soft(localHeadSubject).toBe(PUSHED_TIP_FIXTURE.rewordedSubject);
            expect.soft(counts).toEqual({ ahead: 0, behind: 0 });
            expect.soft(localStatus).toEqual([]);
        },
        originOracle: async ({ fixtureWorkspace, before }) => {
            const [originAfter, localHead] = await Promise.all([
                origin.refOid(fixtureWorkspace, before.originRef),
                localGit.headOid(fixtureWorkspace),
            ]);
            // Both halves are load-bearing: inequality proves the origin ref actually moved, while
            // equality proves it moved specifically to IntelliGit's rewritten local HEAD rather
            // than to an unrelated commit.
            expect.soft(origin.didRefMove(before.originHead, originAfter)).toBe(true);
            expect.soft(originAfter).toBe(localHead);
        },
        durableStateOracle: assertDurableStateClean,
    },
];
