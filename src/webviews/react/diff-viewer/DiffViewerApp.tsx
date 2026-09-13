// Entry point for the standalone diff viewer.
import React from "react";
import { createRoot } from "react-dom/client";
import { DiffViewer } from "./DiffViewer";
import { useDiffViewerHost } from "./diffViewerHost";

/** Connects the shared viewer to the standalone page's message channel. */
export function App(): React.ReactElement {
    const host = useDiffViewerHost();
    return <DiffViewer host={host} />;
}

const container = document.getElementById("root");

/**
 * The mounted root, exported so whoever owns the page can take the app back down.
 *
 * `null` when there is no `#root`, which is every import that is not the webview itself.
 * The webview never unmounts -- the editor disposes the whole document instead -- so this
 * exists for callers that mount the module more than once in one page. Integration tests
 * do exactly that, once per case, and without a handle they cannot undo it: an App that is
 * never unmounted keeps the `message` listener its effect registered, so a later
 * `setDiffData` is re-rendered by every instance the file has mounted so far, each one
 * still holding the full fibre tree of a diff nothing can see any more.
 */
// This is the entry module, so the handle cannot live anywhere else, and there is no Fast
// Refresh in this build to protect (esbuild, no react-refresh transform).
// react-doctor-disable-next-line react-doctor/only-export-components
export const root = container ? createRoot(container) : null;
root?.render(<App />);
