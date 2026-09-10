/**
 * Provider-level test for the redundant `setCommitDetail` post fix in
 * `src/views/CommitGraphViewProvider.ts`, pinning the ONE invariant `postCommitDetailState`'s
 * duplicate-post guard (`lastPostedPayload`, ~line 933) cannot see on its own: VS Code tears a
 * hidden `WebviewView`'s context down and reloads it on show. The bundle re-runs and re-announces
 * itself with a second `ready`, but `resolveWebviewView` -- and the `lastPostedPayload` reset it
 * performs -- does NOT run again for that reload; only the `ready` handler's OWN reset (~line 292,
 * immediately before `postCommitDetailState()`) stands between this and a suppressed repost.
 * Without it, a guard keyed purely on payload equality would treat the restored (but blank)
 * webview's first `setCommitDetail` as a no-op repeat of what the previous, now-dead context
 * already received, and the reloaded pane would render with no commit detail at all.
 *
 * Modeled directly on `tests/unit/views/CommitInfoViewProvider.test.ts`'s own third `it` block,
 * which pins the identical invariant for the sibling provider -- same shared duplicate-post guard
 * (`src/views/shared/postedPayload.ts`), same reload scenario, same shape of proof.
 *
 * **Observation seam.** Option (a), not (b): a small LOCAL inspectable `vscode.WebviewView` double
 * built in this file (`createInspectableFakeCommitGraphWebviewView`), mirroring
 * `CommitInfoViewProvider.test.ts`'s own `createInspectableFakeWebviewView` rather than
 * `commitInfoVscodeDouble.ts`'s `createFakeCommitGraphWebviewView` -- that function's `postMessage`
 * is fixed at `() => Promise.resolve(true)` with no capture hook, so it cannot answer "what was
 * posted, and how many times". The E2E capture seam (`captureWebviewViewProvider` /
 * `setE2eControlChannelActive`) the visual recorder uses is a heavier alternative built for
 * recording canonicalized fixtures across a process-wide sink; a provider-level unit test asserting
 * directly on posted messages needs neither the sink's global state nor the E2E gate, so this file
 * does not pull it in.
 *
 * **Construction.** Everything else is copied from the recorder that already builds a real
 * `CommitGraphViewProvider` end to end, `tests/visual/recorder/recordCommitGraphWebviewFixture.ts`:
 * a real `GitOps` over a real seeded git repository (`loadInitial()`'s `getLog` /
 * `getUnpushedCommitHashes` calls are never mocked), an inert `CredentialStore` over a
 * `throwingDouble`-backed `vscode.SecretStorage`, and `buildProviderOptions("card")` -- reused
 * directly rather than re-typed by hand -- to keep `commitChecksProviders: []`, so the constructor
 * never builds the four real HTTP-backed commit-check providers (see that function's own doc
 * comment on the commit-checks trap).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCommitInfoVscodeDouble } from "../../visual/recorder/commitInfoVscodeDouble";

// Hoisted above the imports below -- see `recordCommitInfoWebviewFixture.test.ts` (and
// `CommitInfoViewProvider.test.ts`, which this file otherwise mirrors) for why this must be a
// plain, non-mocked import ahead of the `vi.mock` call it feeds.
vi.mock("vscode", () => createCommitInfoVscodeDouble());

import type * as vscode from "vscode";
import { createFakeExtensionUri } from "../../visual/recorder/commitInfoVscodeDouble";
import { throwingDouble } from "../../visual/recorder/throwingDouble";
import { toGitEnvironment } from "../../visual/recorder/recordingGitEnvironment";
import { buildProviderOptions } from "../../visual/recorder/recordCommitGraphWebviewFixture";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { CredentialStore } from "../../../src/services/commitChecks/credentialStore";
import { CommitGraphViewProvider } from "../../../src/views/CommitGraphViewProvider";
import type { CommitDetail } from "../../../src/types";
import { FIXTURE_REFS, seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
import { createScratchWorkspaces } from "../fixtures/scratchWorkspaces";

/** A resolve-context/token stand-in `resolveWebviewView` never reads -- same reasoning as
 * `CommitInfoViewProvider.test.ts`'s own `INERT_CONTEXT`/`INERT_TOKEN`. */
const INERT_CONTEXT = {} as vscode.WebviewViewResolveContext;
const INERT_TOKEN = {} as vscode.CancellationToken;

/** Resolves once every microtask queued synchronously up to this call has drained -- see
 * `CommitInfoViewProvider.test.ts`'s own `flushMicrotasks` doc comment for why a single
 * `setImmediate` tick is sufficient to observe `decorateAndStoreCommitDetail`'s settled effects:
 * the shared `IconThemeService.decorateCommitDetailWithFolderIcons` call both providers' decoration
 * paths await has no real timer or I/O wait anywhere in its chain. */
function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** A `vscode.SecretStorage` double for `CredentialStore` -- every member throws by name (see
 * `throwingDouble.ts`). `buildProviderOptions("card")` always passes `commitChecksProviders: []`,
 * so no commit-check provider that could read a stored secret is ever constructed; a throw here
 * would mean a real secret read happened, which would be a finding, not an expected path. Mirrors
 * `recordCommitGraphWebviewFixture.ts`'s own `createInertSecretStorage`. */
function createInertSecretStorage(): vscode.SecretStorage {
    return throwingDouble<vscode.SecretStorage>("secretStorage", {});
}

/** A minimal local `vscode.WebviewView` double with an inspectable `posted` array -- see this
 * file's own doc comment for why this is the chosen observation seam. Same member set
 * `CommitInfoViewProvider.test.ts`'s own `createInspectableFakeWebviewView` implements, PLUS the
 * two members `CommitGraphViewProvider.resolveWebviewView` additionally reaches for: `visible`
 * (read synchronously inside the `ready` handler to post the webview's own initial
 * `setViewVisibility` message) and `onDidChangeVisibility` (registered unconditionally on every
 * resolution, to forward real host visibility into the webview) -- see `commitInfoVscodeDouble.ts`'s
 * own `createFakeCommitGraphWebviewView` doc comment for the same accounting against
 * `CommitInfoViewProvider`'s smaller member set. */
function createInspectableFakeCommitGraphWebviewView(): {
    readonly webviewView: vscode.WebviewView;
    readonly posted: unknown[];
    receiveMessage(message: unknown): Promise<void>;
} {
    let messageHandler: ((message: unknown) => unknown) | undefined;
    const posted: unknown[] = [];

    const webview = {
        options: {} as vscode.WebviewOptions,
        html: "",
        cspSource: "vscode-webview://fake-commit-graph-provider-test",
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
            messageHandler = listener;
            return { dispose(): void {} };
        },
        postMessage: (message: unknown) => {
            posted.push(message);
            return Promise.resolve(true);
        },
    };

    const webviewView = {
        webview,
        visible: true,
        onDidDispose: () => ({ dispose(): void {} }),
        onDidChangeVisibility: () => ({ dispose(): void {} }),
    } as unknown as vscode.WebviewView;

    return {
        webviewView,
        posted,
        receiveMessage: async (message: unknown): Promise<void> => {
            if (!messageHandler) {
                throw new Error(
                    "createInspectableFakeCommitGraphWebviewView.receiveMessage: no message " +
                        "handler was registered yet -- resolveWebviewView() must run first.",
                );
            }
            await messageHandler(message);
        },
    };
}

/** A well-formed `CommitDetail` -- verbatim from `CommitInfoViewProvider.test.ts`'s own
 * `sampleDetail()`. Its exact field values are never asserted on here; what matters is that it has
 * real, decoratable production shape, not a minimal stub. */
function sampleDetail(): CommitDetail {
    return {
        hash: "b08ddf030532f359194329a212f0d9ba54bb6a02",
        shortHash: "b08ddf03",
        message: "Add conflict target",
        body: "",
        author: "IntelliGit Fixture Repo",
        email: "intelligit-fixture@example.invalid",
        date: "2000-01-01T01:00:00Z",
        parentHashes: ["70fa528600605d9b3f1fce7aa04ec799ed494ffd"],
        refs: [],
        files: [{ path: "conflict.txt", status: "A", additions: 3, deletions: 0 }],
    };
}

function setDetailMessages(posted: readonly unknown[]): Record<string, unknown>[] {
    return posted.filter(
        (message): message is Record<string, unknown> =>
            isRecord(message) && message.type === "setCommitDetail",
    );
}

let parentDir: string;
let workspace: FixtureTemplate;
const scratch = createScratchWorkspaces();

beforeAll(async () => {
    parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-commitgraph-provider-test-"));
    scratch.register(parentDir);
    // A single seeded root is enough: unlike the recorder's own byte-identical test, nothing
    // here compares two independently seeded workspaces. Both describes below only read it, so
    // one seed serves the whole file.
    workspace = await seedFixtureTemplate(path.join(parentDir, "root"));
    // `home` lives OUTSIDE `parentDir` (it is `mkdtemp`'d under the OS temp root by
    // `createSanitizedGitEnv`) -- see `scratchWorkspaces.ts`'s own doc comment for why it must
    // be registered explicitly rather than assumed to be removed along with `parentDir`.
    scratch.register(workspace.home);
}, 60_000);

afterAll(async () => {
    await scratch.removeAll();
});

describe("CommitGraphViewProvider redundant setCommitDetail post on webview reload", () => {
    it(
        "re-posts the currently selected commit detail when a torn-down webview sends a second " +
            "`ready` with no intervening resolveWebviewView, even though the payload is " +
            "byte-identical to what the previous (now dead) webview context received",
        async () => {
            const gitOps = new GitOps(
                new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env)),
            );
            const credentialStore = new CredentialStore(createInertSecretStorage());
            const provider = new CommitGraphViewProvider(
                createFakeExtensionUri(),
                gitOps,
                credentialStore,
                buildProviderOptions("card"),
            );
            const { webviewView, posted, receiveMessage } =
                createInspectableFakeCommitGraphWebviewView();

            provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
            await receiveMessage({ type: "ready" });

            provider.setCommitDetail(sampleDetail());
            await flushMicrotasks();

            const beforeReload = setDetailMessages(posted);
            expect(
                beforeReload.length,
                "setCommitDetail() must post at least once before any reload is simulated",
            ).toBeGreaterThanOrEqual(1);
            const postedBeforeReload = beforeReload.length;

            // VS Code tears a hidden WebviewView's context down and reloads it on show. The
            // script re-runs and announces itself with a second `ready`, but the provider is
            // already resolved, so `resolveWebviewView` -- and its `lastPostedPayload` reset --
            // does NOT run again. The detail is byte-identical to the one posted before the
            // reload, so a duplicate guard keyed only on the payload would suppress it and leave
            // the restored pane empty. This is the regression the `ready` handler's OWN reset
            // (`src/views/CommitGraphViewProvider.ts`, ~line 292) prevents.
            await receiveMessage({ type: "ready" });
            await flushMicrotasks();

            const afterReload = setDetailMessages(posted);
            expect(
                afterReload.length,
                "the reloaded webview must receive a NEW setCommitDetail post -- it must not be " +
                    "suppressed as a duplicate of what the previous, now-dead webview context " +
                    "already received",
            ).toBeGreaterThan(postedBeforeReload);
            expect(
                afterReload[afterReload.length - 1],
                "the re-sent payload must be byte-identical to the last one the dead context " +
                    "received -- a guard keyed only on payload equality would have swallowed " +
                    "exactly this repost, which is the whole point of this test",
            ).toEqual(beforeReload[postedBeforeReload - 1]);
        },
    );
});

/** Every `loadCommits` page the provider posted, in posted order. */
function loadCommitsPages(posted: readonly unknown[]): Record<string, unknown>[] {
    return posted.filter(
        (message): message is Record<string, unknown> =>
            isRecord(message) && message.type === "loadCommits",
    );
}

/** The commit hashes of the LAST `loadCommits` page the provider posted, in posted order. */
function loadedCommitHashes(posted: readonly unknown[]): string[] {
    const pages = loadCommitsPages(posted);
    const commits = pages.length === 0 ? [] : pages[pages.length - 1].commits;
    if (!Array.isArray(commits)) return [];
    return commits.map((commit) => (isRecord(commit) ? String(commit.hash) : String(commit)));
}

/** The branch the LAST `setSelectedBranch` message announced, or a readable stand-in when the
 * provider never announced one -- a bare `undefined` in a failure line reads like a message that
 * arrived carrying nothing, which is a different defect from one that never arrived. */
function lastAnnouncedBranch(posted: readonly unknown[]): unknown {
    const picks = posted.filter(
        (message): message is Record<string, unknown> =>
            isRecord(message) && message.type === "setSelectedBranch",
    );
    return picks.length === 0
        ? "<no setSelectedBranch message was ever posted>"
        : picks[picks.length - 1].branch;
}

/**
 * Regression cover for #226: the sidebar graph opened on `git log --all`.
 *
 * Both registrations in `src/activation/repositoryMode.ts` construct this same class, and each
 * instance holds its OWN `currentBranch` filter, defaulted to `null`. `loadInitial` turns that
 * `null` into `--all` (`GitOps.getLog`), so a graph nobody had clicked a branch in drew every
 * branch's history. The bottom panel hides that behind its own branch column -- clicking a branch
 * there scopes it -- but the compact sidebar bundle (`NativeCommitGraph.tsx`) has no branch picker
 * at all, so it had no way out of `--all` and its rows never matched the `Branch: X` label drawn
 * directly above them.
 *
 * Built on the "compact" variant specifically: that is the registration the issue reports, and
 * `buildProviderOptions("compact")` reuses production's own `compactCommitGraphViewOptions()`
 * rather than a hand-copy of it.
 *
 * The oracle is behavioural, over the real seeded repository, not a recorded `getLog` argument:
 * `feature/awesome`'s tip is reachable from that branch and from no other, so its presence in the
 * posted page is proof the log ran unscoped, and `main`'s own tip being present at the same time
 * is the control -- it stays green under every mutation here, so an empty page can never be
 * mistaken for a correctly scoped one.
 */
describe("CommitGraphViewProvider default branch scope (#226)", () => {
    async function resolveGraphOnSeededRepo(): Promise<{
        provider: CommitGraphViewProvider;
        posted: unknown[];
        receiveMessage(message: unknown): Promise<void>;
    }> {
        const gitOps = new GitOps(
            new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env)),
        );
        const provider = new CommitGraphViewProvider(
            createFakeExtensionUri(),
            gitOps,
            new CredentialStore(createInertSecretStorage()),
            buildProviderOptions("compact"),
        );
        const { webviewView, posted, receiveMessage } =
            createInspectableFakeCommitGraphWebviewView();

        // The host's own order (repositoryMode.ts:1351): branch data is handed to the provider,
        // then the webview announces itself and the provider draws its first page.
        provider.setBranches(await gitOps.getBranches());
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });

        return { provider, posted, receiveMessage };
    }

    it("draws only the checked-out branch's history on its first page, not every branch's", async () => {
        const { posted } = await resolveGraphOnSeededRepo();
        const hashes = loadedCommitHashes(posted);

        expect(
            hashes,
            "the control: the checked-out branch's own tip must be on the page, so an empty or " +
                "failed page can never be mistaken for a correctly scoped one",
        ).toContain(workspace.commits.mergeCommit);
        expect(
            hashes,
            "`feature/awesome`'s tip reached the page, and it is reachable from that branch and " +
                "from no other -- so the first page ran unscoped (`git log --all`) instead of " +
                "being scoped to the branch HEAD is on",
        ).not.toContain(workspace.commits.featureCommit3);
    });

    it("announces the checked-out branch so the graph's own `Branch:` label matches what it drew", async () => {
        const { posted } = await resolveGraphOnSeededRepo();

        expect(
            lastAnnouncedBranch(posted),
            "the webview was never told which branch its rows belong to, so its selected-branch " +
                "label cannot agree with the history underneath it",
        ).toBe(FIXTURE_REFS.main);
    });

    // Following HEAD is only a DEFAULT. Both entry points that let something pick a branch on the
    // user's behalf must claim the filter, or the next refresh -- and refreshes are automatic,
    // fired by the file watcher -- would drag the graph straight back onto HEAD's branch.
    // `feature/awesome` forked before `main`'s topic merge, so the two tips discriminate in both
    // directions: whichever branch the page is scoped to, exactly one of them is on it.
    it.each([
        [
            "a branch clicked in the graph's own branch column",
            async (
                provider: CommitGraphViewProvider,
                receiveMessage: (message: unknown) => Promise<void>,
            ) => {
                void provider;
                await receiveMessage({ type: "filterBranch", branch: FIXTURE_REFS.feature });
            },
        ],
        [
            "a branch chosen through the host's filterByBranch command",
            async (
                provider: CommitGraphViewProvider,
                receiveMessage: (message: unknown) => Promise<void>,
            ) => {
                void receiveMessage;
                await provider.filterByBranch(FIXTURE_REFS.feature);
            },
        ],
    ])("keeps %s when the graph is refreshed afterwards", async (_name, pick) => {
        const { provider, posted, receiveMessage } = await resolveGraphOnSeededRepo();

        await pick(provider, receiveMessage);
        await provider.refresh();
        const hashes = loadedCommitHashes(posted);

        expect(
            hashes,
            "the picked branch's own tip is not on the refreshed page, so the refresh dropped the " +
                "pick (an empty or failed page lands here too)",
        ).toContain(workspace.commits.featureCommit3);
        expect(
            hashes,
            "`main`'s tip is not reachable from the picked branch, so the refresh threw the " +
                "pick away and re-scoped the graph back onto the branch HEAD is on",
        ).not.toContain(workspace.commits.mergeCommit);
    });

    it("re-scopes itself when branch data reaches the provider only after the first page is drawn", async () => {
        const gitOps = new GitOps(
            new GitExecutor(workspace.root, undefined, toGitEnvironment(workspace.env)),
        );
        const provider = new CommitGraphViewProvider(
            createFakeExtensionUri(),
            gitOps,
            new CredentialStore(createInertSecretStorage()),
            buildProviderOptions("compact"),
        );
        const { webviewView, posted, receiveMessage } =
            createInspectableFakeCommitGraphWebviewView();

        // The OTHER host ordering: a view resolves and its bundle signals `ready` while
        // activation is still awaiting `getBranches()`, so the provider's first page is drawn
        // with no branch list to read HEAD from. Nothing calls `refresh()` after activation's own
        // `setBranches` (repositoryMode.ts:1351), so if that call does not reload, the graph
        // stays on every branch until some unrelated file change happens to fire the watcher.
        provider.resolveWebviewView(webviewView, INERT_CONTEXT, INERT_TOKEN);
        await receiveMessage({ type: "ready" });
        provider.setBranches(await gitOps.getBranches());

        // The reload `setBranches` starts is fire-and-forget and runs real `git log`, so poll for
        // the second page rather than assuming one microtask tick is enough.
        await vi.waitFor(() => {
            expect(
                loadCommitsPages(posted).length,
                "branch data arriving after the first page never triggered a second, scoped " +
                    "load, so the graph was left showing every branch",
            ).toBeGreaterThan(1);
        });
        const hashes = loadedCommitHashes(posted);

        expect(hashes, "the control: HEAD's own tip must be on the reloaded page").toContain(
            workspace.commits.mergeCommit,
        );
        expect(
            hashes,
            "the reload ran, but still unscoped -- `feature/awesome`'s tip is on the page",
        ).not.toContain(workspace.commits.featureCommit3);
    });

    it("re-follows HEAD after resetFilters, instead of carrying the previous repository's pick into the next one", async () => {
        const { provider, posted, receiveMessage } = await resolveGraphOnSeededRepo();

        await receiveMessage({ type: "filterBranch", branch: FIXTURE_REFS.feature });
        // What the host calls before it points these providers at a different repository root.
        provider.resetFilters();
        await provider.refresh();
        const hashes = loadedCommitHashes(posted);

        expect(hashes, "the control: HEAD's own tip must be back on the page").toContain(
            workspace.commits.mergeCommit,
        );
        expect(
            hashes,
            "the previous pick still owned the filter after resetFilters, so the graph opened " +
                "unscoped (`git log --all`) rather than on the new repository's own HEAD",
        ).not.toContain(workspace.commits.featureCommit3);
    });

    // `registerRepositoryViewEvents` mirrors each graph's pick onto its sibling through
    // `filterByBranch`. That is loop-free only while `filterByBranch` stays silent: if it
    // re-announced the pick, the sibling's mirror would call straight back, forever.
    it("does not re-announce a host-driven pick, so the two graphs' mirror cannot bounce it back", async () => {
        const { provider, receiveMessage } = await resolveGraphOnSeededRepo();
        const announced: (string | null)[] = [];
        provider.onBranchFilterChanged((branch) => announced.push(branch));

        await provider.filterByBranch(FIXTURE_REFS.feature);
        expect(
            announced,
            "filterByBranch re-fired onBranchFilterChanged, so the sibling graph's mirror would " +
                "call filterByBranch back and the two graphs would re-scope each other forever",
        ).toEqual([]);

        await receiveMessage({ type: "filterBranch", branch: FIXTURE_REFS.main });
        expect(
            announced,
            "the control: a pick made inside the graph's own webview must still be announced, or " +
                "the listener above could never have heard anything",
        ).toEqual([FIXTURE_REFS.main]);
    });
});
