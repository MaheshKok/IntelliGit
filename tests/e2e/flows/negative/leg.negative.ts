import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, it } from "vitest";

import { GitExecutor } from "../../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../../src/shelf/paths";
import { ShelfStore } from "../../../../src/shelf/store";
import { ShelfService } from "../../../../src/services/shelfService";
import { createFixtureWorkspace, type FixtureWorkspace } from "../../../fixtures/repo/harness";
import {
    DIVERGENCE_FIXTURE,
    DIRTY_FIXTURE,
    PUSHED_TIP_FIXTURE,
} from "../../../fixtures/repo/scenarios";
import { FIXTURE_REFS } from "../../../fixtures/repo/seed";
import { runGit } from "../../../fixtures/repo/gitRun";
import { captureBeforeState, FLOW_MATRIX, type FlowBeforeState, type FlowRow } from "../matrix";
import { oracles } from "../../../oracles";

const LEG_IDS = ["local-git", "origin", "durable-state", "lock-residue"] as const;
type NegativeLeg = (typeof LEG_IDS)[number];
type OracleContext = Parameters<FlowRow["localGitOracle"]>[0];
type Oracle = (context: OracleContext) => Promise<void>;

const requestedLeg = process.env.FLOW_ORACLE_NEGATIVE_LEG;
const controlMode = process.env.FLOW_ORACLE_NEGATIVE_CONTROL === "1";
const leg =
    requestedLeg === undefined
        ? undefined
        : LEG_IDS.includes(requestedLeg as NegativeLeg)
          ? (requestedLeg as NegativeLeg)
          : (() => {
                throw new Error(
                    `FLOW_ORACLE_NEGATIVE_LEG must be one of ${LEG_IDS.join(", ")}, got "${requestedLeg}".`,
                );
            })();

const localGit = oracles.get("localGit");
const origin = oracles.get("origin");
const durableState = oracles.get("durableState");

const workspaces = new Map<string, Promise<FixtureWorkspace>>();

/** Returns a fresh fixture for one matrix row and retains it for afterAll disposal. */
function workspaceFor(flow: FlowRow): Promise<FixtureWorkspace> {
    const key = flow.id;
    const existing = workspaces.get(key);
    if (existing !== undefined) return existing;
    const created = createFixtureWorkspace({ scenario: flow.scenario });
    workspaces.set(key, created);
    return created;
}

/** Converts the fixture's optional process environment into the executor's string-only contract. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
}

/** Produces the repository state that the selected row's non-UI oracles expect after its action. */
async function prepareGroundTruth(
    flow: FlowRow,
    workspace: FixtureWorkspace,
    before: FlowBeforeState,
): Promise<void> {
    const { root, env } = workspace;
    const baselineDurableState = await durableState.readDurableState(workspace);
    await mkdir(baselineDurableState.globalStoragePath, { recursive: true });
    switch (flow.id) {
        case "commit":
            await runGit(
                root,
                [
                    "commit",
                    "--quiet",
                    "--only",
                    "-m",
                    "phase 4 commit slice",
                    "--",
                    DIRTY_FIXTURE.mutablePath,
                ],
                env,
            );
            return;
        case "branch-checkout":
            await runGit(root, ["checkout", "--quiet", FIXTURE_REFS.feature], env);
            return;
        case "pull":
            await runGit(root, ["rebase", `${FIXTURE_REFS.remote}/${FIXTURE_REFS.main}`], env);
            return;
        case "push":
            await runGit(root, ["push", "--quiet", FIXTURE_REFS.remote, FIXTURE_REFS.main], env);
            return;
        case "interactive-rebase":
            await runGit(
                root,
                ["commit", "--quiet", "--amend", "-m", DIVERGENCE_FIXTURE.rewordedSubject],
                env,
            );
            return;
        case "discard-changes":
            await runGit(root, ["reset", "--hard", "HEAD"], env);
            await runGit(root, ["clean", "-fd", "--quiet"], env);
            return;
        case "shelf-apply":
            await applySeededShelf(workspace);
            return;
        case "abort-active-operation":
            await runGit(root, ["rebase", "--abort"], env);
            return;
        case "merge-conflict-resolve": {
            const unresolvedPaths = [
                ...new Set(
                    before.status
                        .filter(
                            (entry) => entry.indexStatus === "U" || entry.worktreeStatus === "U",
                        )
                        .map((entry) => entry.path),
                ),
            ];
            for (const repositoryPath of unresolvedPaths) {
                const ours = await localGit.headPathContent(workspace, repositoryPath);
                await writeFile(path.join(root, repositoryPath), ours, "utf8");
                await runGit(root, ["add", "--", repositoryPath], env);
            }
            return;
        }
        case "force-push-with-lease":
            await runGit(
                root,
                ["commit", "--quiet", "--amend", "-m", PUSHED_TIP_FIXTURE.rewordedSubject],
                env,
            );
            await runGit(
                root,
                ["push", "--quiet", "--force-with-lease", FIXTURE_REFS.remote, FIXTURE_REFS.main],
                env,
            );
            return;
        default:
            throw new Error(`No direct ground-truth setup exists for matrix row "${flow.id}".`);
    }
}

/** Replays the seeded shelf action through the same real storage contract used by the scenario. */
async function applySeededShelf(workspace: FixtureWorkspace): Promise<void> {
    if (workspace.shelfStorageRoot === undefined) {
        throw new Error("shelf-apply ground truth requires a shelf storage root.");
    }
    const shelfPaths = await resolveShelfPaths({
        repositoryRoot: workspace.root,
        globalStoragePath: workspace.shelfStorageRoot,
    });
    const store = new ShelfStore(shelfPaths);
    const service = new ShelfService({
        repositoryRoot: workspace.root,
        executor: new GitExecutor(workspace.root, undefined, definedEnv(workspace.env)),
        store,
        gate: new RepositoryMutationGate(new RepositoryMutationCoordinator(), new RepositoryLock()),
    });
    const listed = await service.listShelves();
    const shelfId = listed.shelfIds[0];
    if (shelfId === undefined) throw new Error("shelf-apply ground truth found no seeded shelf.");
    const manifest = await store.readCurrentShelfManifest(shelfId);
    await service.unshelve({
        id: shelfId,
        changeIds: manifest.files.map((entry) => entry.changeId),
        removeFromShelf: true,
        mode: "exactState",
        expectedShelfGeneration: manifest.generation,
    });
}

/** Plants a local-only mismatch that each row's local-git assertions can observe. */
async function corruptLocalGit(flow: FlowRow, workspace: FixtureWorkspace): Promise<void> {
    if (flow.id === "shelf-apply") {
        await writeFile(
            path.join(workspace.root, "untracked.txt"),
            "wrong local content\n",
            "utf8",
        );
        return;
    }
    await writeFile(
        path.join(workspace.root, "flow-oracle-negative-local.txt"),
        "unexpected\n",
        "utf8",
    );
}

/** Moves only the bare-origin ref to a new child commit, leaving the working tree untouched. */
async function corruptOrigin(workspace: FixtureWorkspace, before: FlowBeforeState): Promise<void> {
    const current = await origin.refOid(workspace, before.originRef);
    const tree = await runGit(
        workspace.originRoot,
        ["rev-parse", `${current}^{tree}`],
        workspace.env,
    );
    const replacement = await runGit(
        workspace.originRoot,
        ["commit-tree", tree, "-p", current, "-m", "flow oracle negative origin"],
        workspace.env,
    );
    await runGit(
        workspace.originRoot,
        ["update-ref", before.originRef, replacement],
        workspace.env,
    );
}

/** Writes one durable artifact into the exact storage namespace that the selected row reads. */
async function corruptDurableState(flow: FlowRow, workspace: FixtureWorkspace): Promise<void> {
    const globalStoragePath = flow.id === "shelf-apply" ? workspace.shelfStorageRoot : undefined;
    if (globalStoragePath === undefined && flow.id === "shelf-apply") {
        throw new Error("durable-state shelf corruption requires a shelf storage root.");
    }
    const snapshot = await durableState.readDurableState(workspace, { globalStoragePath });
    const target =
        flow.id === "shelf-apply"
            ? path.join(
                  snapshot.rebaseRepositoryDirectory,
                  "manifests",
                  "flow-oracle-negative.json",
              )
            : path.join(snapshot.shelfRoot, "flow-oracle-negative.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "durable-state residue\n", "utf8");
}

/** Plants both lock surfaces and leaves them present long enough for the oracle polls to time out. */
async function corruptLockResidue(workspace: FixtureWorkspace): Promise<void> {
    const snapshots = [
        await durableState.readDurableState(workspace),
        ...(workspace.shelfStorageRoot === undefined
            ? []
            : [
                  await durableState.readDurableState(workspace, {
                      globalStoragePath: workspace.shelfStorageRoot,
                  }),
              ]),
    ];
    for (const snapshot of snapshots) {
        await mkdir(path.dirname(snapshot.repoLockPath), { recursive: true });
        await writeFile(snapshot.repoLockPath, "repository lock residue\n", "utf8");
        await mkdir(snapshot.shelfLockDirectory, { recursive: true });
        await writeFile(
            path.join(snapshot.shelfLockDirectory, "store.lock"),
            "shelf lock residue\n",
            "utf8",
        );
    }
}

/** Applies exactly the selected leg corruption after the row's expected state is established. */
async function corruptSelectedLeg(
    selectedLeg: NegativeLeg,
    flow: FlowRow,
    workspace: FixtureWorkspace,
    before: FlowBeforeState,
): Promise<void> {
    switch (selectedLeg) {
        case "local-git":
            await corruptLocalGit(flow, workspace);
            return;
        case "origin":
            await corruptOrigin(workspace, before);
            return;
        case "durable-state":
            await corruptDurableState(flow, workspace);
            return;
        case "lock-residue":
            await corruptLockResidue(workspace);
            return;
    }
}

/** Selects one row callback without maintaining a second row inventory. */
function oracleFor(flow: FlowRow, selectedLeg: NegativeLeg): Oracle {
    switch (selectedLeg) {
        case "local-git":
            return flow.localGitOracle;
        case "origin":
            return flow.originOracle;
        case "durable-state":
        case "lock-residue":
            return flow.durableStateOracle;
    }
}

/** Adds the same leg label used by the Playwright matrix runner to every expected failure. */
async function runOracleLeg(
    label: NegativeLeg,
    flow: FlowRow,
    oracle: Oracle,
    context: OracleContext,
): Promise<void> {
    try {
        await oracle(context);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} oracle failed for row ${flow.id}: ${message}`, { cause: error });
    }
}

/** Disposes every expensive fixture created by this explicit negative subprocess. */
afterAll(async () => {
    await Promise.all(
        [...workspaces.values()].map(async (workspace) => (await workspace).dispose()),
    );
    workspaces.clear();
});

describe("four-way flow oracle known-bad fixture", () => {
    for (const flow of FLOW_MATRIX) {
        it(
            leg === undefined || controlMode
                ? `control: ${flow.id}`
                : `known-bad: ${leg}: ${flow.id}`,
            async () => {
                const workspace = await workspaceFor(flow);
                const before = await captureBeforeState(workspace);
                await prepareGroundTruth(flow, workspace, before);
                if (leg !== undefined && !controlMode) {
                    await corruptSelectedLeg(leg, flow, workspace, before);
                }
                const context = { fixtureWorkspace: workspace, before } as OracleContext;
                const selectedLeg = leg ?? "local-git";
                await runOracleLeg(selectedLeg, flow, oracleFor(flow, selectedLeg), context);
            },
            180_000,
        );
    }
});
