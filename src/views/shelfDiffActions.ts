import * as vscode from "vscode";
import type { ShelfFileEntry } from "../shelf/model";
import {
    beginEditableDiffSession,
    createReadonlyDiffUri,
    openUnifiedDiff,
} from "../services/diffService";
import type { SideSpec } from "../services/diffService";
import { openEditableDiff } from "../diff/editableDiffOpener";
import { editablePaneForSides } from "../diff/editableDiffTypes";
import type { NativeDiffDelegate } from "../diff/unifiedDiffTypes";

/** The immutable shelf comparison selected by the webview. */
export type ShelfDiffMode = "baseToShelved" | "shelvedToLocal";

/** Host-side data required to render shelf artifacts as virtual diff documents. */
export interface ShelfDiffReader {
    getShelfFiles(shelfId: string): Promise<readonly ShelfFileEntry[]>;
    getShelfDiffContents(
        shelfId: string,
        changeId: string,
    ): Promise<{ path: string; binary: boolean; base?: Buffer; shelved: Buffer }>;
}

interface ShelfDiffDeps {
    shelfReader: ShelfDiffReader;
    getWorkspaceRoot: () => vscode.Uri;
}

type ShelfChange = [vscode.Uri, vscode.Uri, vscode.Uri];

const BASE_LABEL = "Base (HEAD at shelve)";
const SHELVED_LABEL = "Shelved";
const LOCAL_LABEL = "Local";
const UNAVAILABLE_BASE = "Base content is unavailable for this shelf entry.";
const BINARY_DIFF_PLACEHOLDER = "Binary file — text diff is unavailable.";

/**
 * Opens shelf artifacts, immutable except for a `shelvedToLocal` comparison's local side.
 *
 * Single-change requests route through `openShelfChangeDiff`, which picks the editable editor or the
 * read-only viewer by whether a working-tree side exists. The whole-shelf overview stays native --
 * `vscode.changes` has no unified-viewer equivalent -- and never substitutes the local file for base.
 */
export async function showShelfDiffFromPanel(
    deps: ShelfDiffDeps,
    shelfId: string,
    changeId: string | undefined,
    mode: ShelfDiffMode,
    newTab = false,
): Promise<void> {
    if (changeId !== undefined) {
        await openShelfChangeDiff(deps, shelfId, changeId, mode, newTab);
        return;
    }

    const files = await deps.shelfReader.getShelfFiles(shelfId);
    const snapshots = await Promise.all(
        files.map(async (file) => {
            const contents = await deps.shelfReader.getShelfDiffContents(shelfId, file.changeId);
            // Native vscode.changes path (never goes through the funnel), so the local read is
            // unconditional here whenever the pane needs it -- there is no decline to gate on.
            const localSnapshot =
                !contents.binary && mode === "shelvedToLocal"
                    ? await readLocalSnapshot(deps.getWorkspaceRoot(), contents.path)
                    : undefined;
            return snapshotFor(contents, mode, localSnapshot);
        }),
    );
    const changes = snapshots.map(
        (snapshot): ShelfChange => [snapshot.left, snapshot.left, snapshot.right],
    );
    await vscode.commands.executeCommand("vscode.changes", `Shelf ${shelfId}`, changes);
    if (newTab) await vscode.commands.executeCommand("workbench.action.keepEditor");
}

type ShelfContents = Awaited<ReturnType<ShelfDiffReader["getShelfDiffContents"]>>;

/**
 * Routes one shelved change to the editable diff editor, or to the read-only viewer when neither
 * side is the working tree.
 *
 * Shelf content is read once, up front (matching the prior single-read behavior), and shared by both
 * the funnel providers and the native fallback closure so a decline never re-reads or risks divergent
 * content. `baseToShelved` compares two immutable shelf snapshots and stays in the read-only viewer;
 * non-binary `shelvedToLocal` compares a shelf snapshot with the live worktree file and opens the
 * editable editor, so edits to the local side write through to disk. Binary content has no
 * working-tree side on either mode and therefore stays read-only.
 */
async function openShelfChangeDiff(
    deps: ShelfDiffDeps,
    shelfId: string,
    changeId: string,
    mode: ShelfDiffMode,
    newTab: boolean,
): Promise<void> {
    const contents = await deps.shelfReader.getShelfDiffContents(shelfId, changeId);
    const workspaceRoot = deps.getWorkspaceRoot();
    const repoRoot = workspaceRoot.fsPath;
    const identityPrefix = `${shelfId}:${changeId}:${mode}`;
    const { left, right, leftLabel, rightLabel } = shelfChangeRequestSides(
        contents,
        mode,
        identityPrefix,
    );
    const title = `${contents.path} (${leftLabel} <-> ${rightLabel})`;

    const request = { repoRoot, path: contents.path, left, right, languageId: "", title };
    const nativeDelegate: NativeDiffDelegate = async (cancellationToken) => {
        // Matches snapshotFor's own read condition: a local read only fires for the one case
        // that ever needed it, so a decline never triggers a needless filesystem/document probe.
        const localSnapshot =
            !contents.binary && mode === "shelvedToLocal"
                ? await readLocalSnapshot(deps.getWorkspaceRoot(), contents.path)
                : undefined;
        const snapshot = snapshotFor(contents, mode, localSnapshot);
        if (cancellationToken.isCancellationRequested) return;
        const fallbackTitle = `${snapshot.path} (${snapshot.leftLabel} <-> ${snapshot.rightLabel})`;
        const options = newTab ? [{ preview: false }] : [];
        await vscode.commands.executeCommand(
            "vscode.diff",
            snapshot.left,
            snapshot.right,
            fallbackTitle,
            ...options,
        );
    };

    if (editablePaneForSides(left, right)) {
        await openEditableDiff(
            { ...request, fileUri: vscode.Uri.joinPath(workspaceRoot, contents.path) },
            nativeDelegate,
            beginEditableDiffSession,
        );
        return;
    }
    await openUnifiedDiff(request, nativeDelegate);
}

/**
 * Builds the funnel's left/right sides for one shelved change from already-fetched content.
 *
 * Binary content always renders as the same placeholder on both sides regardless of mode, matching
 * the pre-funnel behavior of never attempting to decode shelf bytes reported as binary. Non-binary
 * `shelvedToLocal` uses a live `worktree` side so it shares the funnel's dirty-document precedence
 * instead of a bespoke local read.
 */
function shelfChangeRequestSides(
    contents: ShelfContents,
    mode: ShelfDiffMode,
    identityPrefix: string,
): { left: SideSpec; right: SideSpec; leftLabel: string; rightLabel: string } {
    const providerSide = (
        label: string,
        bytes: Buffer,
        binary: boolean,
        side: string,
    ): SideSpec => ({
        kind: "provider",
        label,
        identity: `${identityPrefix}:${side}`,
        load: () => Promise.resolve({ status: "loaded", bytes, mode: 0o100644, binary }),
    });

    if (contents.binary) {
        const [leftLabel, rightLabel] =
            mode === "baseToShelved" ? [BASE_LABEL, SHELVED_LABEL] : [SHELVED_LABEL, LOCAL_LABEL];
        const placeholder = Buffer.from(BINARY_DIFF_PLACEHOLDER, "utf8");
        return {
            left: providerSide(leftLabel, placeholder, true, "left"),
            right: providerSide(rightLabel, placeholder, true, "right"),
            leftLabel,
            rightLabel,
        };
    }
    if (mode === "baseToShelved") {
        const hasBase = contents.base !== undefined;
        const leftLabel = hasBase ? BASE_LABEL : "Base unavailable";
        return {
            left: providerSide(
                leftLabel,
                hasBase ? contents.base! : Buffer.from(UNAVAILABLE_BASE, "utf8"),
                false,
                "left",
            ),
            right: providerSide(SHELVED_LABEL, contents.shelved, false, "right"),
            leftLabel,
            rightLabel: SHELVED_LABEL,
        };
    }
    return {
        left: providerSide(SHELVED_LABEL, contents.shelved, false, "left"),
        right: { kind: "worktree" },
        leftLabel: SHELVED_LABEL,
        rightLabel: LOCAL_LABEL,
    };
}

function snapshotFor(
    contents: ShelfContents,
    mode: ShelfDiffMode,
    localSnapshot?: string,
): {
    path: string;
    left: vscode.Uri;
    right: vscode.Uri;
    leftLabel: string;
    rightLabel: string;
} {
    if (contents.binary) {
        const [leftLabel, rightLabel] =
            mode === "baseToShelved" ? [BASE_LABEL, SHELVED_LABEL] : [SHELVED_LABEL, LOCAL_LABEL];
        return {
            path: contents.path,
            left: createReadonlyDiffUri(contents.path, BINARY_DIFF_PLACEHOLDER, leftLabel),
            right: createReadonlyDiffUri(contents.path, BINARY_DIFF_PLACEHOLDER, rightLabel),
            leftLabel,
            rightLabel,
        };
    }
    const shelved = createReadonlyDiffUri(
        contents.path,
        contents.shelved.toString("utf8"),
        SHELVED_LABEL,
    );
    if (mode === "baseToShelved") {
        const base = createReadonlyDiffUri(
            contents.path,
            contents.base?.toString("utf8") ?? UNAVAILABLE_BASE,
            contents.base ? BASE_LABEL : "Base unavailable",
        );
        return {
            path: contents.path,
            left: base,
            right: shelved,
            leftLabel: contents.base ? BASE_LABEL : "Base unavailable",
            rightLabel: SHELVED_LABEL,
        };
    }

    return {
        path: contents.path,
        left: shelved,
        right: createReadonlyDiffUri(contents.path, localSnapshot ?? "", LOCAL_LABEL),
        leftLabel: SHELVED_LABEL,
        rightLabel: LOCAL_LABEL,
    };
}

async function readLocalSnapshot(workspaceRoot: vscode.Uri, filePath: string): Promise<string> {
    const file = vscode.Uri.joinPath(workspaceRoot, filePath);
    const openDocument = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === file.toString(),
    );
    if (openDocument) return openDocument.getText();
    try {
        await vscode.workspace.fs.stat(file);
        return (await vscode.workspace.openTextDocument(file)).getText();
    } catch (error) {
        if (isFileNotFoundError(error)) return "";
        throw error;
    }
}

function isFileNotFoundError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (("code" in error && error.code === "FileNotFound") ||
            ("message" in error &&
                typeof error.message === "string" &&
                error.message.includes("Unable to resolve nonexistent file")))
    );
}
