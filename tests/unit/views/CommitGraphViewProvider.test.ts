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
import { seedFixtureTemplate, type FixtureTemplate } from "../../fixtures/repo/seed";
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

describe("CommitGraphViewProvider redundant setCommitDetail post on webview reload", () => {
    let parentDir: string;
    let workspace: FixtureTemplate;
    const scratch = createScratchWorkspaces();

    beforeAll(async () => {
        parentDir = await mkdtemp(path.join(tmpdir(), "intelligit-commitgraph-provider-test-"));
        scratch.register(parentDir);
        // A single seeded root is enough: unlike the recorder's own byte-identical test, nothing
        // here compares two independently seeded workspaces.
        workspace = await seedFixtureTemplate(path.join(parentDir, "root"));
        // `home` lives OUTSIDE `parentDir` (it is `mkdtemp`'d under the OS temp root by
        // `createSanitizedGitEnv`) -- see `scratchWorkspaces.ts`'s own doc comment for why it must
        // be registered explicitly rather than assumed to be removed along with `parentDir`.
        scratch.register(workspace.home);
    }, 60_000);

    afterAll(async () => {
        await scratch.removeAll();
    });

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
