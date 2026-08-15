/**
 * Phase 2c-v-b's recorder: records the conflicted scenario for the merge-editor resolved host
 * context, MergeEditorPanel (src/views/MergeEditorPanel.ts), IntelliGit's native three-way editor
 * for one conflicted file. conflicted, not clean: postConflictData() reads Git index stages and a
 * clean repository would only exercise its loadError branch (MergeEditorPanel.ts:299-306).
 *
 * The panel is produced internally, and open() posts nothing. MergeEditorPanel.open() calls
 * vscode.window.createWebviewPanel(...) and wraps it with captureWebview(rawPanel, "merge-editor")
 * (MergeEditorPanel.ts:132-145), so the recorder reaches the result through webviewPanelDouble.ts's
 * construction registry. The only producer of the captured setConflictData message is the ready
 * branch in handleMessage() (:174-176), so this recorder must drive panel.receiveMessage({ type:
 * "ready" }) after production has registered its handler.
 *
 * Configuration is pinned by this recording. readEditorFontSize() (MergeEditorPanel.ts:52-59)
 * catches a missing configuration member and turns it into undefined; JSON.stringify then drops
 * editorFontSize from the payload. Installing the explicit { "editor.fontSize": 14 } store makes
 * the visual baseline reproducible and gives the unit test a direct value oracle.
 *
 * Disposal is part of the recording and runs in finally. MergeEditorPanel.panels is a process-wide
 * static map (MergeEditorPanel.ts:70) populated before the ready-driven Git read (:155); if that
 * read throws, ordinary happy-path cleanup would leave a failed panel in the map and the next
 * open() would silently take the reuse branch (:123-129). The configuration reset is directly
 * asserted after both a failed and a successful recording. A direct panel-layer test proves that
 * disposal clears the static map; no test currently forces a rejection between panels.set() and
 * the recorder's return, so cleanup in that specific window is covered by construction rather than
 * by an oracle.
 */

import type * as vscode from "vscode";

import { GitExecutor } from "../../../src/git/executor";
import { GitOps } from "../../../src/git/operations";
import { isE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
    type WebviewContextId,
} from "../../../src/e2e/webviewCapture";
import {
    MergeEditorPanel,
    type MergeEditorPanelOptions,
} from "../../../src/views/MergeEditorPanel";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { createFakeExtensionUri } from "./commitInfoVscodeDouble";
import { toGitEnvironment } from "./recordingGitEnvironment";
import { throwingDouble } from "./throwingDouble";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";
import { getCreatedWebviewPanels, resetCreatedWebviewPanelsForTests } from "./webviewPanelDouble";
import {
    resetFakeWorkspaceConfigurationForTests,
    setFakeWorkspaceConfiguration,
} from "./workspaceConfigurationDouble";

/** The one repository state this recorder accepts: a real merge stopped on a content conflict. */
export const MERGE_EDITOR_CONFLICTED_SCENARIO = "conflicted";

const MERGE_EDITOR_CONTEXT_ID: WebviewContextId = "merge-editor";

export interface RecordMergeEditorWebviewFixtureOptions {
    /** Absolute path to a real seeded repository already prepared in the conflicted state. */
    readonly repoRoot: string;
    /** Concrete roots this recording's canonicalization pass rewrites to placeholders. */
    readonly roots: PlaceholderRoots;
    /** The scenario's sanitized Git environment; inheriting the ambient environment is forbidden. */
    readonly env: NodeJS.ProcessEnv;
}

/** The exact configuration pinned for a visual baseline, independent of the host's VS Code state. */
export function buildMergeEditorWorkspaceConfiguration(): Record<string, unknown> {
    return { "editor.fontSize": 14 };
}

interface MergeEditorCallbacksDouble {
    onConflictStateChanged: () => Promise<void>;
}

/**
 * Builds the callback valid for this read-only recording. It is intentionally throwingDouble-
 * backed: no resolution message is driven, so an invocation is an unexpected path and must name
 * the callback rather than silently succeeding.
 */
function createMergeEditorCallbacks(): MergeEditorCallbacksDouble {
    return throwingDouble<MergeEditorCallbacksDouble>("mergeEditorCallbacks", {
        onConflictStateChanged: async (): Promise<void> => {
            throw new Error(
                "mergeEditorCallbacks.onConflictStateChanged was invoked during a recording; " +
                    "the merge-editor fixture must not resolve a conflict.",
            );
        },
    });
}

/**
 * Builds the options passed to MergeEditorPanel.open() (MergeEditorPanel.ts:31-37). The root
 * getter is deliberately a closure over the caller's repository root because production reads it
 * only on applyResolution (MergeEditorPanel.ts:226-228), a path this recorder never drives; the
 * direct unit oracle is therefore the only evidence that the correct root was captured.
 */
export function buildMergeEditorPanelOptions(input: {
    readonly extensionUri: vscode.Uri;
    readonly gitOps: GitOps;
    readonly repoRoot: string;
    readonly filePath: string;
}): MergeEditorPanelOptions {
    const callbacks = createMergeEditorCallbacks();
    return {
        extensionUri: input.extensionUri,
        gitOps: input.gitOps,
        getRepoRoot: () => input.repoRoot,
        filePath: input.filePath,
        onConflictStateChanged: callbacks.onConflictStateChanged,
    };
}

/**
 * Records one canonicalized merge-editor / conflicted fixture. An inactive E2E gate is rejected
 * before any state is changed because captureWebview returns the raw panel identity-equal when
 * inactive (src/e2e/webviewCapture.ts:8-9), which would otherwise silently produce an empty
 * fixture.
 */
export async function recordMergeEditorWebviewFixture(
    options: RecordMergeEditorWebviewFixtureOptions,
): Promise<WebviewFixture> {
    if (!isE2eControlChannelActive()) {
        throw new Error(
            "recordMergeEditorWebviewFixture: the E2E control channel gate " +
                "(isE2eControlChannelActive()) is inactive. Recording through an inactive gate " +
                "would silently produce an EMPTY fixture because captureWebview returns the " +
                "unwrapped panel identity-equal when the gate is off. Call " +
                "setE2eControlChannelActive(true) before recording.",
        );
    }

    // Reset before constructing GitOps: this recording owns the process-wide capture, panel, and
    // configuration state, so a previous test cannot contribute bytes or a static panel entry.
    resetE2eWebviewCaptureSinkForTests();
    resetCreatedWebviewPanelsForTests();
    resetFakeWorkspaceConfigurationForTests();

    // The third constructor argument is the scenario's sanitized environment, not a convenience:
    // GitExecutor otherwise inherits the developer's global Git configuration
    // (recordingGitEnvironment.ts's top-level defect explanation).
    const gitOps = new GitOps(
        new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env)),
    );

    try {
        setFakeWorkspaceConfiguration(buildMergeEditorWorkspaceConfiguration());

        // Derive the path from real porcelain status rather than hardcoding conflict.txt, so a
        // changed conflicted scenario fails with its actual entry count instead of recording a path
        // that no longer represents the scenario (GitOps.getConflictFilesDetailed() reads
        // status --porcelain=v1 -z -uall, src/git/operations.ts:1561-1587).
        const conflictFiles = await gitOps.getConflictFilesDetailed();
        if (conflictFiles.length !== 1) {
            throw new Error(
                "recordMergeEditorWebviewFixture: the conflicted scenario must contain exactly " +
                    "one conflicted file, but GitOps.getConflictFilesDetailed() returned " +
                    conflictFiles.length +
                    ". A count of 0 means this workspace is not in the required conflicted " +
                    "state; a count above 1 means the scenario changed and this recorder must be " +
                    "told which file it records.",
            );
        }
        const filePath = conflictFiles[0].path;

        await MergeEditorPanel.open(
            buildMergeEditorPanelOptions({
                extensionUri: createFakeExtensionUri(),
                gitOps,
                repoRoot: options.repoRoot,
                filePath,
            }),
        );

        const createdPanels = getCreatedWebviewPanels();
        if (createdPanels.length !== 1) {
            throw new Error(
                "recordMergeEditorWebviewFixture: expected MergeEditorPanel.open() to create " +
                    "exactly one new webview panel, but " +
                    createdPanels.length +
                    " were created. A count of 0 means open() took the reuse branch " +
                    "(MergeEditorPanel.ts:123-129) because a previous recording left an entry in " +
                    "the static panels Map -- the panel double's dispose() failed to fire its " +
                    "onDidDispose listeners.",
            );
        }

        const panel = createdPanels[0];
        // The ONLY producer of the captured setConflictData message is the ready branch in
        // MergeEditorPanel.handleMessage (MergeEditorPanel.ts:174-176), not open() itself.
        await panel.receiveMessage({ type: "ready" });

        const sink = getE2eWebviewCaptureSink();
        if (!sink) {
            throw new Error(
                "recordMergeEditorWebviewFixture: the E2E gate was active, but no webview capture " +
                    "sink was allocated. MergeEditorPanel.open() did not reach its captured " +
                    "createWebviewPanel path, so this is a recorder failure rather than an empty " +
                    "scenario.",
            );
        }

        const captured = sink
            .getMessages()
            .filter((message) => message.contextId === MERGE_EDITOR_CONTEXT_ID);
        const canonicalized = canonicalizeCapturedMessages(captured, options.roots, []);
        return buildWebviewFixture(
            MERGE_EDITOR_CONTEXT_ID,
            MERGE_EDITOR_CONFLICTED_SCENARIO,
            canonicalized,
        );
    } finally {
        // The configuration reset is proven after both success and rejection. Iterate the live
        // construction registry rather than a captured panel binding: a failure after
        // MergeEditorPanel.open() can have created a panel and published the static Map entry.
        // Disposal's static-map effect is proven directly, but no test forces the narrow
        // panels.set()-to-return rejection window; this cleanup remains covered by construction for
        // that window.
        for (const panel of getCreatedWebviewPanels()) panel.dispose();
        resetCreatedWebviewPanelsForTests();
        resetE2eWebviewCaptureSinkForTests();
        resetFakeWorkspaceConfigurationForTests();
    }
}
