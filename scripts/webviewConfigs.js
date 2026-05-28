const WEBVIEW_CONFIGS = [
    { entry: "react/CommitGraphApp", out: "webview-commitgraph" },
    { entry: "react/CompactCommitGraphApp", out: "webview-compactcommitgraph" },
    { entry: "react/commit-panel/CommitPanelApp", out: "webview-commitpanel" },
    { entry: "react/CommitInfoApp", out: "webview-commitinfo" },
    { entry: "react/merge-editor/MergeEditorApp", out: "webview-mergeeditor" },
    {
        entry: "react/merge-conflicts-session/MergeConflictSessionApp",
        out: "webview-mergeconflictsession",
    },
    { entry: "react/UndockedApp", out: "webview-undocked" },
];

module.exports = { WEBVIEW_CONFIGS };
