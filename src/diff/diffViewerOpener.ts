import * as vscode from "vscode";
import {
    DiffViewerPanel,
    type DiffViewerPanelOptions,
    type DiffViewerPanelSessionBinding,
} from "../views/DiffViewerPanel";

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

/** Claims the reusable panel before a session's asynchronous side loads finish. */
export function claimDiffViewerSession(binding: DiffViewerPanelSessionBinding): void {
    DiffViewerPanel.claimSession(binding);
}

/** Clears a session binding only when the panel still belongs to that generation. */
export function clearDiffViewerSession(generation: number): void {
    DiffViewerPanel.clearSessionBinding(generation);
}

/** Reports a refresh failure only when the reusable panel still belongs to that generation. */
export async function reportDiffViewerLoadError(
    generation: number,
    message: string,
): Promise<void> {
    await DiffViewerPanel.postLoadError(generation, message);
}

/** Opens the reusable viewer after the funnel has completed all host-side gates. */
export async function openDiffViewer(options: ViewerOptions): Promise<void> {
    if (!diffViewerExtensionUri) {
        throw new Error("Diff viewer extension URI has not been initialized.");
    }
    await DiffViewerPanel.open({ extensionUri: diffViewerExtensionUri, ...options });
}
