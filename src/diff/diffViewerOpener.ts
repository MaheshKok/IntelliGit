import * as vscode from "vscode";
import { DiffViewerPanel, type DiffViewerPanelOptions } from "../views/DiffViewerPanel";

type ViewerOptions = Omit<DiffViewerPanelOptions, "extensionUri">;

let diffViewerExtensionUri: vscode.Uri | undefined;

/**
 * Supplies the activated extension URI used by the reusable diff viewer.
 *
 * Activation owns this wiring because the viewer opener is shared by services
 * and must not resolve the published marketplace identifier at call time.
 */
export function setDiffViewerExtensionUri(extensionUri: vscode.Uri): void {
    diffViewerExtensionUri = extensionUri;
}

/** Opens the Phase 1 reusable viewer after the funnel has completed all host-side gates. */
export async function openDiffViewer(options: ViewerOptions): Promise<void> {
    if (!diffViewerExtensionUri) {
        throw new Error("Diff viewer extension URI has not been initialized.");
    }
    await DiffViewerPanel.open({ extensionUri: diffViewerExtensionUri, ...options });
}
