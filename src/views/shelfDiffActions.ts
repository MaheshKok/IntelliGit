import * as vscode from "vscode";
import type { ShelfFileEntry } from "../shelf/model";
import { createReadonlyDiffUri } from "../services/diffService";

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

/** Opens shelf artifacts as immutable virtual documents, never substituting the local file for base. */
export async function showShelfDiffFromPanel(
    deps: ShelfDiffDeps,
    shelfId: string,
    changeId: string | undefined,
    mode: ShelfDiffMode,
): Promise<void> {
    if (changeId !== undefined) {
        const snapshot = await snapshotFor(deps, shelfId, changeId, mode);
        await vscode.commands.executeCommand(
            "vscode.diff",
            snapshot.left,
            snapshot.right,
            `${snapshot.path} (${snapshot.leftLabel} <-> ${snapshot.rightLabel})`,
        );
        return;
    }

    const files = await deps.shelfReader.getShelfFiles(shelfId);
    const snapshots = await Promise.all(
        files.map((file) => snapshotFor(deps, shelfId, file.changeId, mode)),
    );
    const changes = snapshots.map((snapshot): ShelfChange => [
        snapshot.left,
        snapshot.left,
        snapshot.right,
    ]);
    await vscode.commands.executeCommand("vscode.changes", `Shelf ${shelfId}`, changes);
}

async function snapshotFor(
    deps: ShelfDiffDeps,
    shelfId: string,
    changeId: string,
    mode: ShelfDiffMode,
): Promise<{
    path: string;
    left: vscode.Uri;
    right: vscode.Uri;
    leftLabel: string;
    rightLabel: string;
}> {
    const contents = await deps.shelfReader.getShelfDiffContents(shelfId, changeId);
    if (contents.binary) {
        const [leftLabel, rightLabel] =
            mode === "baseToShelved"
                ? [BASE_LABEL, SHELVED_LABEL]
                : [SHELVED_LABEL, LOCAL_LABEL];
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

    const local = await readLocalSnapshot(deps.getWorkspaceRoot(), contents.path);
    return {
        path: contents.path,
        left: shelved,
        right: createReadonlyDiffUri(contents.path, local, LOCAL_LABEL),
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
