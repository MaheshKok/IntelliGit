/**
 * Phase 2c-v-c's recorder: records the `mid-rebase` scenario for the internally-created `undocked`
 * webview panel owned by `UndockedViewProvider` (`src/views/UndockedViewProvider.ts`). `open()` only
 * installs the panel and its handlers; the provider's `ready` branch is the producer of the graph,
 * history, configuration, and working-tree messages this fixture captures.
 *
 * The constructor policy is intentionally extracted. `UndockedViewProvider` otherwise constructs
 * four HTTP-backed commit-check providers, two of which receive a credential store. Passing an
 * empty provider list is what prevents provider construction; disabling the coordinator is what
 * prevents a future check read from reaching providers. Only one of those two is visible in the
 * payload, so `buildUndockedProviderConstructorArguments` -- the COMPLETE argument tuple, spread at
 * the single construction site -- is the exact-value oracle, and
 * `buildUndockedProviderConstructorOptions` is the policy it carries. See the tuple builder's own
 * comment for the mutation that proved an argument list at the call site is not covered by an
 * assertion on the policy object alone.
 *
 * The `mid-rebase` postcondition is checked before opening the panel. The panel and capture sink are
 * process-wide test seams, while the provider owns a retained panel reference, so every recording
 * resets before use and disposes/resets every seam in `finally`.
 */

import type * as vscode from "vscode";

import { CredentialStore } from "../../../src/services/commitChecks/credentialStore";
import type { CommitChecksSettings } from "../../../src/services/commitChecks/settingsConfig";
import type { HostMap } from "../../../src/services/commitChecks/types";
import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { isE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    type CapturedWebviewMessage,
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
    type WebviewContextId,
} from "../../../src/e2e/webviewCapture";
import { UndockedViewProvider } from "../../../src/views/UndockedViewProvider";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { createFakeExtensionUri, createFakeUriFromPath } from "./commitInfoVscodeDouble";
import { loadRecordingBranches } from "./recordingBranches";
import { toGitEnvironment } from "./recordingGitEnvironment";
import { throwingDouble } from "./throwingDouble";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";
import { getCreatedWebviewPanels, resetCreatedWebviewPanelsForTests } from "./webviewPanelDouble";
import {
    resetFakeWorkspaceConfigurationForTests,
    setFakeWorkspaceConfiguration,
} from "./workspaceConfigurationDouble";
import type { VolatileFieldDeclaration } from "./volatileFieldDeclarations";

/** The one repository state this recorder accepts: an in-progress conflicting rebase. */
export const UNDOCKED_MID_REBASE_SCENARIO = "mid-rebase";

const UNDOCKED_CONTEXT_ID: WebviewContextId = "undocked";

/**
 * All values in the ready fan-out are stable under the fixture repository's pinned Git dates and
 * sanitized environment. The declaration is exported and asserted exactly so a future production
 * field that is genuinely wall-clock or UUID based cannot be added without a named decision.
 */
export const UNDOCKED_MID_REBASE_VOLATILE_FIELDS: readonly VolatileFieldDeclaration[] = [];

export interface RecordUndockedWebviewFixtureOptions {
    /** Absolute path to a real seeded repository already prepared in the `mid-rebase` state. */
    readonly repoRoot: string;
    /** Concrete roots this recording's canonicalization pass rewrites to placeholders. */
    readonly roots: PlaceholderRoots;
    /** The scenario's sanitized Git environment; inheriting the ambient environment is forbidden. */
    readonly env: NodeJS.ProcessEnv;
}

type UndockedProviderOptions = NonNullable<ConstructorParameters<typeof UndockedViewProvider>[7]>;

/**
 * The exact policy-bearing constructor arguments this recorder passes to `UndockedViewProvider`.
 * `workspaceState` and `interactiveRebaseStorageRoot` are absent by construction so ready does not
 * read or write host persistence; the root is explicit in `selectedRepositoryRoot` so the provider
 * cannot silently choose another repository.
 */
export interface UndockedProviderConstructorOptions {
    readonly workspaceState: undefined;
    readonly hostMap: HostMap;
    readonly commitChecksSettings: CommitChecksSettings;
    readonly options: UndockedProviderOptions;
    readonly interactiveRebaseStorageRoot: undefined;
}

/**
 * Builds fresh constructor policy objects. The exact empty provider list keeps this recording off
 * the network and away from the credential store: the production `??` default list is never
 * constructed, and `enabled: false` makes the coordinator return its disabled snapshot before any
 * provider lookup. The returned objects do not share caller-owned mutable state.
 */
export function buildUndockedProviderConstructorOptions(input: {
    readonly repoRoot: string;
}): UndockedProviderConstructorOptions {
    return {
        workspaceState: undefined,
        hostMap: {},
        commitChecksSettings: {
            enabled: false,
            providers: {
                github: false,
                gitlab: false,
                "bitbucket-cloud": false,
                "bitbucket-server": false,
            },
        },
        options: {
            selectedRepositoryRoot: input.repoRoot,
            commitChecksProviders: [],
        },
        interactiveRebaseStorageRoot: undefined,
    };
}

/** The exact configuration keys reached by this recorder's production paths. */
export function buildUndockedWorkspaceConfiguration(): Record<string, unknown> {
    return {
        "intelligit.clearLastCommit": true,
        "intelligit.commitWindowPosition": "auto",
        "workbench.sideBar.location": "right",
    };
}

/** The credential surface is intentionally inert: reaching any member is a recording failure. */
function createInertSecretStorage(): vscode.SecretStorage {
    return throwingDouble<vscode.SecretStorage>("secretStorage", {});
}

type UndockedConstructorArguments = ConstructorParameters<typeof UndockedViewProvider>;

/**
 * The COMPLETE positional argument tuple the recorder hands to `new UndockedViewProvider(...)`,
 * so that assembling those arguments has exactly ONE oracled choke point.
 *
 * Without this, `buildUndockedProviderConstructorOptions` is a trap dressed as an oracle: it proves
 * what the builder RETURNS, not what the constructor RECEIVES. Adversarial review confirmed the
 * gap -- replacing `constructorOptions.options` at the construction site with an inline literal
 * that drops `commitChecksProviders: []` left all 132 tests green, because that barrier is
 * asymmetric with the other one. Discarding `commitChecksSettings` changes recorded bytes (the
 * coordinator's disabled snapshot is visible in the payload) and the fixture gate catches it;
 * discarding the empty provider list changes NO byte, because `enabled: false` short-circuits
 * before any provider is consulted. The four HTTP-backed providers would simply be constructed --
 * two of them handed the credential store -- and nothing would say so.
 *
 * Spreading a built tuple removes the un-oracled seam rather than adding an assertion beside it:
 * there is no positional argument left at the call site to quietly swap, so any equivalent
 * mutation must edit this function, which its own test pins by exact value.
 */
export function buildUndockedProviderConstructorArguments(input: {
    readonly repoRoot: string;
    readonly gitOps: GitOps;
}): UndockedConstructorArguments {
    const policy = buildUndockedProviderConstructorOptions({ repoRoot: input.repoRoot });
    return [
        createFakeExtensionUri(),
        input.gitOps,
        createFakeUriFromPath(input.repoRoot),
        new CredentialStore(createInertSecretStorage()),
        policy.workspaceState,
        policy.hostMap,
        policy.commitChecksSettings,
        policy.options,
        policy.interactiveRebaseStorageRoot,
    ];
}

/**
 * Keeps only the messages this context recorded.
 *
 * Proven at its own layer, and only there -- state that plainly rather than implying more. The
 * recorder resets the process-wide sink before use, and this recording opens exactly one webview,
 * so no foreign-context message can reach the sink today; deleting the filter from the recorder
 * changes no recorded byte and no end-to-end assertion can catch it. Extracting the decision makes
 * it assertable directly, which is this build's standing answer to an invariant the output cannot
 * show. The filter stays because the sink is process-wide by design: the day one recording drives
 * two contexts, this is what keeps the other one's messages out of the fixture.
 */
export function selectUndockedMessages(
    messages: readonly CapturedWebviewMessage[],
): CapturedWebviewMessage[] {
    return messages.filter((message) => message.contextId === UNDOCKED_CONTEXT_ID);
}

/**
 * Records one canonicalized `undocked` / `mid-rebase` fixture. The active-operation guard rejects a
 * seeded workspace that is not actually paused in a rebase before panel creation, while the panel
 * count and capture-sink guards reject reuse or inactive capture that could otherwise produce a
 * plausible but empty fixture.
 */
export async function recordUndockedWebviewFixture(
    options: RecordUndockedWebviewFixtureOptions,
): Promise<WebviewFixture> {
    if (!isE2eControlChannelActive()) {
        throw new Error(
            "recordUndockedWebviewFixture: the E2E control channel gate " +
                "(isE2eControlChannelActive()) is inactive. Recording through an inactive gate " +
                "would silently produce an EMPTY fixture because captureWebview returns the " +
                "unwrapped panel identity-equal when the gate is off. Call " +
                "setE2eControlChannelActive(true) before recording.",
        );
    }

    // This recorder owns all three process-wide seams and must not inherit a previous recording.
    resetE2eWebviewCaptureSinkForTests();
    resetCreatedWebviewPanelsForTests();
    resetFakeWorkspaceConfigurationForTests();

    const gitOps = new GitOps(
        new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env)),
    );

    try {
        setFakeWorkspaceConfiguration(buildUndockedWorkspaceConfiguration());

        const activeOperation = await gitOps.getActiveOperation();
        if (activeOperation !== "rebase") {
            throw new Error(
                `recordUndockedWebviewFixture: expected the ${UNDOCKED_MID_REBASE_SCENARIO} ` +
                    `scenario to have an active rebase, but GitOps.getActiveOperation() returned ` +
                    `"${activeOperation}". Refusing to record a non-rebase workspace.`,
            );
        }

        // Spread a built tuple rather than listing arguments here: see
        // buildUndockedProviderConstructorArguments for why an argument list at this site is an
        // un-oracled seam that adversarial review walked straight through.
        const provider = new UndockedViewProvider(
            ...buildUndockedProviderConstructorArguments({ repoRoot: options.repoRoot, gitOps }),
        );

        // Production's host wiring (`repositoryMode.ts:1103`, inside `loadUndockedData`), applied
        // BEFORE `open()` -- see `recordingBranches.ts` for why an unpopulated provider records
        // `"branches": []` and why this call belongs before the panel exists: the setter caches
        // without posting while no panel exists, so the `ready` handler's own `sendBranches` posts
        // the populated list exactly once.
        //
        // This scenario's detached HEAD does not make the list empty: `mid-rebase` still carries
        // every ref the fixture template seeded, and a detached HEAD is precisely a state where
        // seeing the branch list matters most.
        const { branches, worktrees } = await loadRecordingBranches(
            gitOps,
            options.repoRoot,
            options.env,
        );
        provider.setBranches(branches, worktrees);

        provider.open();

        const createdPanels = getCreatedWebviewPanels();
        if (createdPanels.length !== 1) {
            throw new Error(
                "recordUndockedWebviewFixture: expected UndockedViewProvider.open() to create " +
                    "exactly one new webview panel, but " +
                    createdPanels.length +
                    " were created. A count of 0 means open() reused a retained panel or the " +
                    "panel double failed to register the internally-created panel.",
            );
        }

        // `open()` posts no bootstrap data. The provider's ready branch is the only path that loads
        // branches, commits, settings, and working-tree state for this recording.
        await createdPanels[0].receiveMessage({ type: "ready" });

        const sink = getE2eWebviewCaptureSink();
        if (!sink) {
            throw new Error(
                "recordUndockedWebviewFixture: the E2E gate was active, but no webview capture " +
                    "sink was allocated. open() did not reach its captured createWebviewPanel " +
                    "path, so this is a recorder failure rather than an empty scenario.",
            );
        }

        const captured = selectUndockedMessages(sink.getMessages());
        if (captured.length === 0) {
            throw new Error(
                "recordUndockedWebviewFixture: the undocked capture sink received no messages " +
                    "after the required ready handshake.",
            );
        }
        const canonicalized = canonicalizeCapturedMessages(
            captured,
            options.roots,
            UNDOCKED_MID_REBASE_VOLATILE_FIELDS,
        );
        return buildWebviewFixture(
            UNDOCKED_CONTEXT_ID,
            UNDOCKED_MID_REBASE_SCENARIO,
            canonicalized,
        );
    } finally {
        // Dispose every panel currently owned by this recording before clearing the registry. The
        // provider's panel-dispose callback must run first so theme listeners and retained state are
        // released, then each process-wide registry is reset independently for the next recording.
        for (const panel of getCreatedWebviewPanels()) panel.dispose();
        resetCreatedWebviewPanelsForTests();
        resetE2eWebviewCaptureSinkForTests();
        resetFakeWorkspaceConfigurationForTests();
    }
}
