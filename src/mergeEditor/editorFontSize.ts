/**
 * The effective `editor.fontSize` a merge-editor webview should render code at.
 *
 * Lives beside `conflictParser.ts` -- the module that declares `MergeEditorData.editorFontSize` --
 * rather than inside one panel, because BOTH panels that build a `MergeEditorData` render it
 * through the same webview (`src/webviews/react/merge-editor/MergeEditorApp.tsx`) and the same
 * stylesheet. When this lived privately in `MergeEditorPanel.ts`, `ShelfConflictEditorPanel` built
 * its payload without the field and its code silently fell back to `--vscode-editor-font-size`,
 * so the same conflict rendered at one size in the merge editor and another in the shelf conflict
 * editor from one user setting.
 */

import * as vscode from "vscode";

/** VS Code's own accepted range for `editor.fontSize`; a value outside it is treated as absent. */
const MIN_EDITOR_FONT_SIZE = 6;
const MAX_EDITOR_FONT_SIZE = 100;

/**
 * Reads the effective `editor.fontSize` so the webview can render merge code at the same pixel size
 * as a normal editor.
 *
 * The `--vscode-editor-font-size` webview variable is unreliable (unitless on some VS Code builds),
 * so the host reads the authoritative setting instead. Returns undefined when the value is missing
 * or outside VS Code's own bounds, letting the webview fall back to the CSS variable.
 */
export function readEditorFontSize(): number | undefined {
    try {
        const size = vscode.workspace.getConfiguration("editor").get<number>("fontSize");
        return typeof size === "number" &&
            size >= MIN_EDITOR_FONT_SIZE &&
            size <= MAX_EDITOR_FONT_SIZE
            ? size
            : undefined;
    } catch {
        return undefined;
    }
}
