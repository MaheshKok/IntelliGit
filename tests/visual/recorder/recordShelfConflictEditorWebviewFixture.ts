/**
 * Phase 2c-v-d's recorder: records the `shelf-conflicted` scenario for the internally-created
 * `shelf-conflict-editor` panel (`src/views/ShelfConflictEditorPanel.ts`). The scenario shelves the
 * seeded staged and unstaged layers for `mutable.txt`, then writes a local value different from
 * both reconstructed sides, so `ShelfService.openShelfConflictSession()` supplies a real text
 * conflict to the shared merge-editor webview.
 *
 * `ShelfConflictEditorPanel.open()` calls `load()` itself, and `load()` posts the one
 * `setConflictData` message. There is no ready handshake here: driving `ready` would invoke the
 * same handler a second time and double-record the payload. The recorder therefore opens the panel
 * once, checks one created panel and one captured message, and never calls `receiveMessage()`.
 *
 * The shelf UUID and content-derived change ID are discovered from the scenario's carried shelf
 * storage root. No path is reconstructed from `path.dirname(workspace.root)`, because the scenario
 * gate owns that disposable-destination convention and this recorder must use the exact store the
 * builder wrote. No workspace configuration store is installed or reset here: the panel's captured
 * payload does not read configuration, while `buildWebviewShellHtml()`'s guarded configuration
 * read affects only uncaptured HTML.
 */

import type * as vscode from "vscode";

import { isE2eControlChannelActive } from "../../../src/e2e/activationState";
import {
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
    type CapturedWebviewMessage,
    type WebviewContextId,
} from "../../../src/e2e/webviewCapture";
import { GitExecutor } from "../../../src/git/executor";
import { RepositoryMutationCoordinator } from "../../../src/git/mutationCoordinator";
import { RepositoryLock } from "../../../src/git/repositoryLock";
import { RepositoryMutationGate } from "../../../src/git/repositoryMutationGate";
import { resolveShelfPaths } from "../../../src/shelf/paths";
import { ShelfStore } from "../../../src/shelf/store";
import { ShelfService } from "../../../src/services/shelfService";
import {
    ShelfConflictEditorPanel,
    type ShelfConflictEditorPanelOptions,
} from "../../../src/views/ShelfConflictEditorPanel";
import type { PlaceholderRoots } from "../../fixtures/repo/placeholderCanonicalization";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { createFakeExtensionUri } from "./commitInfoVscodeDouble";
import { toGitEnvironment } from "./recordingGitEnvironment";
import { throwingDouble } from "./throwingDouble";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";
import { getCreatedWebviewPanels, resetCreatedWebviewPanelsForTests } from "./webviewPanelDouble";
import type { VolatileFieldDeclaration } from "./volatileFieldDeclarations";

/** The one repository state this recorder accepts: a real text conflict in a shelf session. */
export const SHELF_CONFLICT_EDITOR_CONFLICTED_SCENARIO = "shelf-conflicted";

const SHELF_CONFLICT_EDITOR_CONTEXT_ID: WebviewContextId = "shelf-conflict-editor";

/**
 * Finding, not omission: no field in `setConflictData.data` is wall-clock- or UUID-derived.
 * `shelfId`, `changeId`, `shelfGeneration`, and `worktreeFingerprint` stay in the host session but
 * never reach this message; declaring a volatile field here would destroy real fixture value.
 */
export const SHELF_CONFLICT_EDITOR_VOLATILE_FIELDS: readonly VolatileFieldDeclaration[] = [];

export interface RecordShelfConflictEditorWebviewFixtureOptions {
    /** Absolute path to the prepared `shelf-conflicted` repository workspace. */
    readonly repoRoot: string;
    /** Exact shelf storage root created by the scenario builder; never re-derived by this recorder. */
    readonly shelfStorageRoot: string;
    /** Concrete roots this recording's canonicalization pass rewrites to placeholders. */
    readonly roots: PlaceholderRoots;
    /** The scenario's sanitized Git environment; inheriting the ambient environment is forbidden. */
    readonly env: NodeJS.ProcessEnv;
}

interface ShelfConflictEditorCallbacksDouble {
    onApplied: () => Promise<void>;
}

/**
 * Builds the callback valid for a read-only recording. `applyResolution`, `acceptYours`, and
 * `acceptTheirs` all reach `onApplied` after production writes the worktree; any invocation is an
 * unexpected mutation path and must fail by name rather than silently making the recorder unsafe.
 */
function createShelfConflictEditorCallbacks(): ShelfConflictEditorCallbacksDouble {
    return throwingDouble<ShelfConflictEditorCallbacksDouble>("shelfConflictEditorCallbacks", {
        onApplied: async (): Promise<void> => {
            throw new Error(
                "shelfConflictEditorCallbacks.onApplied was invoked during a recording; " +
                    "a recording must never apply a resolution.",
            );
        },
    });
}

/**
 * Builds the COMPLETE `ShelfConflictEditorPanelOptions` object passed to `open()`. The recorder
 * binds its result to one local const and passes that const directly, leaving no inline option
 * assembly at the production call site for repository, shelf, change, or callback values to drift.
 */
export function buildShelfConflictEditorPanelOptions(input: {
    readonly extensionUri: vscode.Uri;
    readonly repositoryRoot: string;
    readonly shelfService: ShelfConflictEditorPanelOptions["shelfService"];
    readonly shelfId: string;
    readonly changeId: string;
}): ShelfConflictEditorPanelOptions {
    const callbacks = createShelfConflictEditorCallbacks();
    return {
        extensionUri: input.extensionUri,
        repositoryRoot: input.repositoryRoot,
        shelfService: input.shelfService,
        shelfId: input.shelfId,
        changeId: input.changeId,
        onApplied: callbacks.onApplied,
    };
}

/**
 * Keeps only messages this context recorded.
 *
 * Proven at its own layer, and ONLY there: reset-before-use plus one opened panel means no foreign
 * context can reach this sink today, so deleting the inline filter would change no byte and no
 * end-to-end assertion could catch it. The extracted filter is the direct oracle for this decision;
 * it does not imply broader multi-context coverage.
 */
export function selectShelfConflictEditorMessages(
    messages: readonly CapturedWebviewMessage[],
): CapturedWebviewMessage[] {
    return messages.filter((message) => message.contextId === SHELF_CONFLICT_EDITOR_CONTEXT_ID);
}

async function createShelfService(options: {
    readonly repoRoot: string;
    readonly shelfStorageRoot: string;
    readonly env: NodeJS.ProcessEnv;
}): Promise<{ readonly store: ShelfStore; readonly service: ShelfService }> {
    const shelfPaths = await resolveShelfPaths({
        repositoryRoot: options.repoRoot,
        globalStoragePath: options.shelfStorageRoot,
    });
    const store = new ShelfStore(shelfPaths);
    const executor = new GitExecutor(options.repoRoot, undefined, toGitEnvironment(options.env));
    const gate = new RepositoryMutationGate(
        new RepositoryMutationCoordinator(),
        new RepositoryLock(),
    );
    return {
        store,
        service: new ShelfService({
            repositoryRoot: options.repoRoot,
            executor,
            store,
            gate,
        }),
    };
}

async function readShelfConflictIds(store: ShelfStore): Promise<{
    readonly shelfId: string;
    readonly changeId: string;
}> {
    const { shelfIds } = await store.listShelves();
    if (shelfIds.length !== 1) {
        throw new Error(
            "recordShelfConflictEditorWebviewFixture: expected exactly one shelf in the " +
                `scenario storage, but found ${shelfIds.length}.`,
        );
    }
    const shelfId = shelfIds[0];
    const manifest = await store.readCurrentShelfManifest(shelfId);
    const entries = manifest.files.filter((entry) => entry.worktreeBlock?.path === "mutable.txt");
    if (entries.length !== 1) {
        throw new Error(
            "recordShelfConflictEditorWebviewFixture: expected exactly one mutable.txt shelf " +
                `entry, but found ${entries.length}.`,
        );
    }
    return { shelfId, changeId: entries[0].changeId };
}

/**
 * Records one canonicalized `shelf-conflict-editor` / `shelf-conflicted` fixture. `open()` itself
 * produces exactly one message; a created-panel count of 0 identifies the static reuse branch, and
 * a captured-message count of 2 identifies a recorder that incorrectly drove `ready` and
 * double-recorded the payload.
 */
export async function recordShelfConflictEditorWebviewFixture(
    options: RecordShelfConflictEditorWebviewFixtureOptions,
): Promise<WebviewFixture> {
    if (!isE2eControlChannelActive()) {
        throw new Error(
            "recordShelfConflictEditorWebviewFixture: the E2E control channel gate " +
                "(isE2eControlChannelActive()) is inactive. Recording through an inactive gate " +
                "would silently produce an EMPTY fixture because captureWebview returns the " +
                "unwrapped panel identity-equal when the gate is off. Call " +
                "setE2eControlChannelActive(true) before recording.",
        );
    }

    // Own only capture and panel seams here. Workspace configuration is intentionally untouched:
    // ShelfConflictEditorPanel does not read it, and its HTML-only shell read is outside this sink.
    resetE2eWebviewCaptureSinkForTests();
    resetCreatedWebviewPanelsForTests();

    try {
        const { store, service } = await createShelfService(options);
        const { shelfId, changeId } = await readShelfConflictIds(store);
        const panelOptions = buildShelfConflictEditorPanelOptions({
            extensionUri: createFakeExtensionUri(),
            repositoryRoot: options.repoRoot,
            shelfService: service,
            shelfId,
            changeId,
        });
        await ShelfConflictEditorPanel.open(panelOptions);

        const createdPanels = getCreatedWebviewPanels();
        if (createdPanels.length !== 1) {
            throw new Error(
                "recordShelfConflictEditorWebviewFixture: expected ShelfConflictEditorPanel.open() " +
                    "to create exactly one new webview panel, but " +
                    `${createdPanels.length} were created. A count of 0 means the reuse branch was ` +
                    "taken because the same repository/shelf/change panel remained in the static " +
                    "panels Map.",
            );
        }

        const sink = getE2eWebviewCaptureSink();
        if (!sink) {
            throw new Error(
                "recordShelfConflictEditorWebviewFixture: the E2E gate was active, but no webview " +
                    "capture sink was allocated. ShelfConflictEditorPanel.open() did not reach " +
                    "its captured createWebviewPanel path, so this is a recorder failure rather " +
                    "than an empty scenario.",
            );
        }

        // `open()` -> `load()` -> `postConflictData({})` is the sole producer. Driving `ready` here
        // would call the same handler a second time and produce two identical messages.
        const captured = selectShelfConflictEditorMessages(sink.getMessages());
        if (captured.length !== 1) {
            throw new Error(
                "recordShelfConflictEditorWebviewFixture: expected exactly one captured " +
                    `shelf-conflict-editor message, but received ${captured.length}. A count of 2 ` +
                    "means the recorder drove a ready handshake even though open() already loaded " +
                    "the conflict data, causing double-recording.",
            );
        }

        const canonicalized = canonicalizeCapturedMessages(
            captured,
            options.roots,
            SHELF_CONFLICT_EDITOR_VOLATILE_FIELDS,
        );
        return buildWebviewFixture(
            SHELF_CONFLICT_EDITOR_CONTEXT_ID,
            SHELF_CONFLICT_EDITOR_CONFLICTED_SCENARIO,
            canonicalized,
        );
    } finally {
        for (const panel of getCreatedWebviewPanels()) panel.dispose();
        resetCreatedWebviewPanelsForTests();
        resetE2eWebviewCaptureSinkForTests();
    }
}
