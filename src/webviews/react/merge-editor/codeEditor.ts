import { Compartment, EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    drawSelection,
    Decoration,
    ViewPlugin,
    type ViewUpdate,
    type DecorationSet,
} from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
    replaceHunks,
    workbenchHunks,
    workbenchHistory,
    type WorkbenchHunk,
} from "./workbenchModel";
import {
    highlightDocument,
    initShiki,
    langForPath,
    type ShikiTheme,
} from "../diff-core/shikiHighlighter";
import {
    alignCompareLinesForWordDiff,
    buildWordDiffMask,
    bridgeChangedWordRuns,
    tokenizeWordDiff,
} from "../../../diff/wordDiff";

const palette = EditorView.theme({
    "&": {
        height: "100%",
        color: "var(--vscode-editor-foreground)",
        backgroundColor: "var(--vscode-editor-background)",
        fontFamily: "var(--vscode-editor-font-family)",
        fontSize: "var(--vscode-editor-font-size)",
    },
    ".cm-scroller": { overflow: "auto", fontFamily: "inherit", lineHeight: "1.6" },
    ".cm-content": { padding: "8px 0", caretColor: "var(--vscode-editorCursor-foreground)" },
    ".cm-gutters": {
        backgroundColor: "var(--vscode-editor-background)",
        color: "color-mix(in srgb, var(--vscode-editorLineNumber-foreground) 60%, var(--vscode-editor-foreground))",
        borderRight: "1px solid var(--vscode-panel-border)",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
        backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--vscode-editor-selectionBackground)",
    },
    ".cm-panels": {
        color: "var(--vscode-foreground)",
        backgroundColor: "var(--vscode-editorWidget-background)",
    },
    ".cm-textfield": {
        color: "var(--vscode-input-foreground)",
        backgroundColor: "var(--vscode-input-background)",
        border: "1px solid var(--vscode-input-border)",
    },
    ".cm-searchMatch": { backgroundColor: "var(--vscode-editor-findMatchHighlightBackground)" },
});

/** Updates only syntax decorations, preserving selections and history. */
export const setMergeSyntax = StateEffect.define<ShikiTheme>();

/** Converts TextMate's font-style flags into inline token styles without changing editor text. */
function tokenStyle(token: { color?: string; fontStyle?: number }): string {
    const flags = token.fontStyle ?? 0;
    return [
        token.color ? `color:${token.color}` : "",
        flags & 1 ? "font-style:italic" : "",
        flags & 2 ? "font-weight:bold" : "",
        flags & 4 ? "text-decoration:underline" : "",
    ]
        .filter(Boolean)
        .join(";");
}

/** Builds grammar-aware token ranges for a normalized CodeMirror document and the current host theme. */
function syntaxDecorations(state: EditorState, filePath: string, theme: ShikiTheme): DecorationSet {
    const language = langForPath(filePath);
    if (!language) return Decoration.none;
    initShiki();
    const tokens = highlightDocument(state.doc.toString().split("\n"), language, theme);
    if (!tokens) return Decoration.none;
    const marks: Range<Decoration>[] = [];
    tokens.forEach((line, index) => {
        let offset = state.doc.line(index + 1).from;
        for (const token of line) {
            const end = offset + token.text.length;
            const style = tokenStyle(token);
            if (end > offset && style)
                marks.push(Decoration.mark({ attributes: { style } }).range(offset, end));
            offset = end;
        }
    });
    return Decoration.set(marks, true);
}

/** Debounces full-document tokenization while mapping existing highlights through intervening edits. */
function syntaxPlugin(filePath: string, initialTheme: ShikiTheme) {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;
            theme = initialTheme;
            timer?: ReturnType<typeof setTimeout>;
            constructor(private readonly view: EditorView) {
                this.decorations = syntaxDecorations(view.state, filePath, this.theme);
            }
            update(update: ViewUpdate) {
                let changed = update.docChanged;
                for (const transaction of update.transactions)
                    for (const effect of transaction.effects)
                        if (effect.is(setMergeSyntax)) {
                            this.theme = effect.value;
                            changed = true;
                        }
                if (!changed) return;
                this.decorations = this.decorations.map(update.changes);
                clearTimeout(this.timer);
                this.timer = setTimeout(() => {
                    this.decorations = syntaxDecorations(this.view.state, filePath, this.theme);
                    this.view.dispatch({});
                }, 100);
            }
            destroy() {
                clearTimeout(this.timer);
            }
        },
        { decorations: (plugin) => plugin.decorations },
    );
}

/** Mirrors decisions into immutable input decorations. */
export const setInputHunks = StateEffect.define<readonly WorkbenchHunk[]>();
const inputHunks = StateField.define<readonly WorkbenchHunk[]>({
    create: () => [],
    update(value, transaction) {
        for (const effect of transaction.effects) if (effect.is(setInputHunks)) return effect.value;
        return value;
    },
});

/** Highlights changed words inside nonempty base ranges without tinting whole-line insertions twice. */
function wordDecorations(state: EditorState, hunks: readonly WorkbenchHunk[]): Range<Decoration>[] {
    const marks: Range<Decoration>[] = [];
    for (const hunk of hunks) {
        if (!hunk.segment.baseLines.length) continue;
        const text = state.doc.sliceString(hunk.from, hunk.to).replace(/\n$/, "");
        const lines = text.split("\n");
        const compared = alignCompareLinesForWordDiff(lines, hunk.segment.baseLines);
        let offset = hunk.from;
        lines.forEach((line, index) => {
            const tokens = tokenizeWordDiff(line);
            const { changed } = bridgeChangedWordRuns(
                tokens,
                buildWordDiffMask(line, compared[index] ?? ""),
            );
            tokens.forEach((token, i) => {
                if (changed[i] && offset + token.length <= state.doc.length)
                    marks.push(
                        Decoration.mark({ class: "merge-word-change" }).range(
                            offset,
                            offset + token.length,
                        ),
                    );
                offset += token.length;
            });
            offset++;
        });
    }
    return marks;
}

/** Rebuilds conflict decorations only when text or decision anchors change. */
function conflictField(readOnly: boolean) {
    return StateField.define<DecorationSet>({
        create: () => Decoration.none,
        update(value, transaction) {
            if (
                !transaction.docChanged &&
                !transaction.effects.some(
                    (effect) => effect.is(replaceHunks) || effect.is(setInputHunks),
                )
            )
                return value;
            const hunks = transaction.state.field(readOnly ? inputHunks : workbenchHunks);
            return Decoration.set(
                [
                    ...hunks.flatMap((hunk) =>
                        hunk.to > hunk.from
                            ? [
                                  Decoration.mark({
                                      class: hunk.resolved
                                          ? "merge-range-resolved"
                                          : "merge-range-pending",
                                  }).range(hunk.from, hunk.to),
                              ]
                            : [],
                    ),
                    ...wordDecorations(transaction.state, hunks),
                ],
                true,
            );
        },
        provide: (field) => EditorView.decorations.from(field),
    });
}

/** Creates a browser-safe editor using bundled TextMate grammars and the host theme. */
export function createMergeCodeEditor(
    parent: HTMLElement,
    content: string,
    options: {
        readOnly: boolean;
        filePath: string;
        label: string;
        theme: ShikiTheme;
        update?: (view: EditorView) => void;
    },
): { view: EditorView; setReadOnly: (readOnly: boolean) => void } {
    const editability = new Compartment();
    const state = EditorState.create({
        doc: content.replace(/\r\n/g, "\n"),
        extensions: [
            palette,
            lineNumbers(),
            drawSelection(),
            highlightActiveLine(),
            syntaxPlugin(options.filePath, options.theme),
            search(),
            highlightSelectionMatches(),
            keymap.of([indentWithTab, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
            editability.of([
                EditorState.readOnly.of(options.readOnly),
                EditorView.editable.of(!options.readOnly),
            ]),
            EditorView.contentAttributes.of({ "aria-label": options.label }),
            ...(options.readOnly ? [inputHunks] : [history(), workbenchHunks, workbenchHistory]),
            conflictField(options.readOnly),
            EditorView.updateListener.of((update) => {
                if (
                    update.docChanged ||
                    update.transactions.some((transaction) =>
                        transaction.effects.some((effect) => effect.is(replaceHunks)),
                    )
                )
                    options.update?.(update.view);
            }),
        ],
    });
    const view = new EditorView({ state, parent });
    return {
        view,
        setReadOnly: (readOnly) =>
            view.dispatch({
                effects: editability.reconfigure([
                    EditorState.readOnly.of(readOnly),
                    EditorView.editable.of(!readOnly),
                ]),
            }),
    };
}
