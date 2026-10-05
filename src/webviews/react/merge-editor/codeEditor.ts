import {
    Compartment,
    EditorState,
    RangeSetBuilder,
    StateEffect,
    StateField,
    type Range,
} from "@codemirror/state";
import {
    EditorView,
    keymap,
    lineNumbers,
    gutter,
    gutterLineClass,
    GutterMarker,
    drawSelection,
    Decoration,
    ViewPlugin,
    type ViewUpdate,
    type DecorationSet,
} from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import type { RefObject } from "react";
import { actionGutter, type HunkActionCallbacks } from "./workbenchGutter";
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
import { LINE_HEIGHT_PX } from "../diff-core/mergeScrollLayout";
import {
    compareLinesFor,
    isPhantomLine,
    ownedLines,
    rowClasses,
    variantClass,
    type WorkbenchPane,
} from "./workbenchRows";

const palette = EditorView.theme({
    "&": {
        height: "auto",
        color: "var(--vscode-editor-foreground)",
        backgroundColor: "transparent",
        fontFamily: "var(--vscode-editor-font-family, monospace)",
        fontSize: "var(--merge-code-font-size, var(--vscode-editor-font-size, 13px))",
    },
    ".cm-scroller": {
        overflow: "hidden",
        fontFamily: "inherit",
        lineHeight: `${LINE_HEIGHT_PX}px`,
        backgroundColor: "transparent",
    },
    ".cm-content": { padding: "0", caretColor: "var(--vscode-editorCursor-foreground)" },
    ".cm-line": { padding: "0 9px" },
    ".cm-gutters": {
        backgroundColor: "transparent",
        color: "color-mix(in srgb, var(--vscode-editorLineNumber-foreground) 60%, var(--vscode-editor-foreground))",
        border: "none",
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
function wordDecorations(
    state: EditorState,
    hunks: readonly WorkbenchHunk[],
    pane: WorkbenchPane,
): Range<Decoration>[] {
    const marks: Range<Decoration>[] = [];
    for (const hunk of hunks) {
        const compareLines = compareLinesFor(hunk, pane);
        if (compareLines === undefined) continue;
        const text = state.doc.sliceString(hunk.from, hunk.to).replace(/\n$/, "");
        const lines = text.split("\n");
        const compared = alignCompareLinesForWordDiff(lines, compareLines);
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
                        Decoration.mark({
                            class: /^\s+$/.test(token)
                                ? "word-diff-change word-diff-whitespace"
                                : "word-diff-change",
                        }).range(offset, offset + token.length),
                    );
                offset += token.length;
            });
            offset++;
        });
    }
    return marks;
}

/** Selects the active hunk without adding a history event. */
export const setActiveHunk = StateEffect.define<number | null>();
const activeHunk = StateField.define<number | null>({
    create: () => null,
    update(value, transaction) {
        for (const effect of transaction.effects) if (effect.is(setActiveHunk)) return effect.value;
        return value;
    },
});

class RowMarker extends GutterMarker {
    constructor(readonly elementClass: string) {
        super();
    }
    eq(other: RowMarker) {
        return this.elementClass === other.elementClass;
    }
}

class TextMarker extends GutterMarker {
    constructor(readonly text: string) {
        super();
    }
    eq(other: TextMarker) {
        return this.text === other.text;
    }
    toDOM() {
        return document.createTextNode(this.text);
    }
}

function formatNumber(number: number, state: EditorState): string {
    // CodeMirror also formats a synthetic width spacer (9, 99, ...) beyond the document.
    return number <= state.doc.lines && isPhantomLine(state.doc, state.doc.line(number))
        ? ""
        : String(number);
}

function numberGutter() {
    return gutter({
        class: "cm-lineNumbers",
        side: "after",
        renderEmptyElements: true,
        lineMarker: (view, block) => {
            const line = view.state.doc.lineAt(block.from);
            return isPhantomLine(view.state.doc, line) ? null : new TextMarker(String(line.number));
        },
    });
}

function hunkRows(state: EditorState, hunk: WorkbenchHunk, pane: WorkbenchPane, active: boolean) {
    if (hunk.from === hunk.to) {
        const line = state.doc.lineAt(hunk.from);
        return isPhantomLine(state.doc, line)
            ? []
            : [{ from: line.from, classes: `mrow mrow-empty ${variantClass(hunk.segment)}` }];
    }
    const lines = ownedLines(state.doc, hunk.from, hunk.to);
    return lines.map((number, index) => ({
        from: state.doc.line(number).from,
        classes: rowClasses(
            hunk,
            pane,
            lines.length === 1
                ? "only"
                : index === 0
                  ? "first"
                  : index === lines.length - 1
                    ? "last"
                    : "middle",
            active,
        ),
    }));
}

function rowDecorations(state: EditorState, pane: WorkbenchPane) {
    const hunks = state.field(pane === "result" ? workbenchHunks : inputHunks);
    const active = state.field(activeHunk);
    const rows = hunks
        .flatMap((hunk, index) => hunkRows(state, hunk, pane, active === index))
        .sort((a, b) => a.from - b.from);
    const gutters = new RangeSetBuilder<GutterMarker>();
    const marks: Range<Decoration>[] = [];
    for (const row of rows) {
        marks.push(Decoration.line({ class: row.classes }).range(row.from));
        gutters.add(row.from, row.from, new RowMarker(row.classes));
    }
    return {
        lines: Decoration.set([...marks, ...wordDecorations(state, hunks, pane)], true),
        gutters: gutters.finish(),
    };
}

/** Shares row classes between code and gutters when text, decisions or active state change. */
function rowField(pane: WorkbenchPane) {
    return StateField.define<ReturnType<typeof rowDecorations>>({
        create: (state) => rowDecorations(state, pane),
        update(value, transaction) {
            if (
                !transaction.docChanged &&
                !transaction.effects.some(
                    (effect) =>
                        effect.is(replaceHunks) ||
                        effect.is(setInputHunks) ||
                        effect.is(setActiveHunk),
                )
            )
                return value;
            return rowDecorations(transaction.state, pane);
        },
        provide: (field) => [
            EditorView.decorations.from(field, (value) => value.lines),
            gutterLineClass.from(field, (value) => value.gutters),
        ],
    });
}

/** Creates a browser-safe editor using bundled TextMate grammars and the host theme. */
export function createMergeCodeEditor(
    parent: HTMLElement,
    content: string,
    options: {
        pane: WorkbenchPane | "base";
        readOnly: boolean;
        filePath: string;
        label: string;
        theme: ShikiTheme;
        actions?: RefObject<HunkActionCallbacks | null>;
        update?: (view: EditorView) => void;
    },
): { view: EditorView; setReadOnly: (readOnly: boolean) => void } {
    const editability = new Compartment();
    const state = EditorState.create({
        doc: content.replace(/\r\n/g, "\n"),
        extensions: [
            palette,
            options.pane === "ours" && options.actions
                ? actionGutter("ours", options.actions, (state) => state.field(inputHunks), "after")
                : [],
            options.pane === "ours" ? numberGutter() : lineNumbers({ formatNumber }),
            options.pane === "theirs" && options.actions
                ? actionGutter("theirs", options.actions, (state) => state.field(inputHunks))
                : [],
            drawSelection(),
            syntaxPlugin(options.filePath, options.theme),
            search(),
            highlightSelectionMatches(),
            keymap.of([indentWithTab, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
            editability.of([
                EditorState.readOnly.of(options.readOnly),
                EditorView.editable.of(!options.readOnly),
            ]),
            EditorView.contentAttributes.of({ "aria-label": options.label }),
            activeHunk,
            ...(options.pane === "base"
                ? []
                : [
                      ...(options.pane === "result"
                          ? [history(), workbenchHunks, workbenchHistory]
                          : [inputHunks]),
                      rowField(options.pane),
                  ]),
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
