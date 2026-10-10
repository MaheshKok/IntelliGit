interface MergeSelectors {
    root: string;
    codeRow: string;
    numberRow: string;
    wordFill: string;
    dismissedRow: string;
    discardButton: string;
    pendingGutterCell: string;
    acceptButton: string;
    ribbonPath: string;
    conflictRibbon: string;
    insertionRibbon: string;
    conflictBoundary: string;
    content: string;
    details: string;
    identity: string;
    summaries: string;
    filePath: string;
    bar: string;
    block: string;
    gutter: string;
    code: string;
    wrappers: string;
    insertionClass: string;
    deletionClass: string;
    modificationClass: string;
    conflictClass: string;
    oursClass: string;
    theirsClass: string;
    resultClass: string;
}

/** The same oracle elements in the retained renderer and the CodeMirror workbench. */
export const mergeSelectors = {
    legacy: {
        root: ".merge-editor",
        codeRow: ".real-code-line",
        numberRow: ".line-number",
        wordFill: ".word-diff-change",
        dismissedRow:
            '[data-conflict-id="1"] .conflict-column.dismissed .conflict-theirs .real-code-line',
        discardButton: '[data-conflict-id="1"] .conflict-actions-right .discard-btn',
        pendingGutterCell: ".change-conflict .conflict-ours .real-line-row",
        acceptButton: ".col-left .conflict-actions-left .accept-btn",
        ribbonPath: "svg.merge-connectors path.merge-connector",
        conflictRibbon: ".merge-connector.change-conflict",
        insertionRibbon: ".merge-connector.variant-insertion",
        conflictBoundary: ".segment-conflict.change-conflict",
        content: ".merge-content",
        details: '[aria-controls="merge-details"]',
        identity: ".merge-title, .merge-stats",
        summaries: ".merge-stat-pill",
        filePath: ".merge-title .file-path",
        bar: ".merge-horizontal-scroll",
        block: ".code-block",
        gutter: ".line-numbers",
        code: ".code-lines",
        wrappers: ".merge-editor .segment-conflict",
        insertionClass: "variant-insertion",
        deletionClass: "variant-deletion",
        modificationClass: "variant-modification",
        conflictClass: "change-conflict",
        oursClass: "conflict-ours",
        theirsClass: "conflict-theirs",
        resultClass: "conflict-result",
    },
    workbench: {
        root: ".merge-editor.workbench",
        codeRow: ".cm-line",
        numberRow: '.cm-lineNumbers .cm-gutterElement:not([aria-hidden="true"])',
        wordFill: ".word-diff-change",
        dismissedRow: ".pane-theirs .cm-line.mrow-insertion.mrow-dismissed",
        discardButton:
            ".pane-theirs .merge-action-gutter .cm-gutterElement.mrow-insertion .conflict-actions-right .discard-btn",
        pendingGutterCell:
            ".pane-ours .cm-lineNumbers .cm-gutterElement.mrow-conflict.mrow-pending",
        acceptButton: ".pane-ours .merge-action-gutter .conflict-actions-left .accept-btn",
        ribbonPath: "svg.merge-connectors path.merge-connector",
        conflictRibbon: ".merge-connector.change-conflict",
        insertionRibbon: ".merge-connector.variant-insertion",
        conflictBoundary: ".pane-ours .cm-line.mrow-conflict.mrow-first.mrow-last",
        content: ".merge-content",
        details: '[aria-controls="merge-details"]',
        identity: ".merge-title, .merge-stats",
        summaries: ".merge-stat-pill",
        filePath: ".merge-title .file-path",
        bar: ".merge-horizontal-scroll",
        block: ".merge-editor.workbench .merge-content .cm-editor",
        gutter: ".cm-lineNumbers",
        code: ".cm-content",
        wrappers: ".merge-editor.workbench .cm-line.mrow",
        insertionClass: "mrow-insertion",
        deletionClass: "mrow-deletion",
        modificationClass: "mrow-modification",
        conflictClass: "mrow-conflict",
        oursClass: "pane-ours",
        theirsClass: "pane-theirs",
        resultClass: "pane-result",
    },
} satisfies Record<"legacy" | "workbench", MergeSelectors>;
