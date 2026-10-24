import React, {
    useDeferredValue,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createRoot } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { search, searchKeymap } from "@codemirror/search";
import {
    VscCheck,
    VscRefresh,
    VscArrowUp,
    VscArrowDown,
    VscArrowRight,
    VscDiff,
} from "react-icons/vsc";
import { getVsCodeApi } from "../shared/vscodeApi";
import { t } from "../shared/i18n";
import { VscCheckbox } from "../shared/components/VscCheckbox";
import { syntaxPlugin, setMergeSyntax } from "../merge-editor/codeEditor";
import { detectTheme } from "../diff-core/shikiHighlighter";
import { changeIds, selectedContent } from "../../../changes/selection";
import type { ChangeBlock, ChangeLine } from "../../protocol/changeSelection";
import type { PartialEditorOutbound, PartialEditorReply } from "../../protocol/changelists";
import "./partial-changes.css";

type FileData = Extract<PartialEditorReply, { type: "partialFile" }>;
interface SavedSelection {
    contentId?: string;
    ids?: string[];
    message?: string;
}
type DiffRow = { kind: "block"; block: ChangeBlock } | { kind: "line"; line: ChangeLine };
const ROW_HEIGHT = 22;

/** A read-only full-document preview uses CodeMirror's native viewport and search. */
function SelectionPreview({ content, filePath }: { content: string; filePath: string }) {
    const root = useRef<HTMLDivElement>(null);
    const editor = useRef<EditorView | null>(null);
    useEffect(() => {
        if (!root.current) return;
        const view = new EditorView({
            parent: root.current,
            state: EditorState.create({
                doc: "",
                extensions: [
                    EditorState.readOnly.of(true),
                    EditorView.editable.of(false),
                    lineNumbers(),
                    search(),
                    keymap.of(searchKeymap),
                    syntaxPlugin(filePath, detectTheme()),
                    EditorView.contentAttributes.of({ "aria-label": t("changes.preview") }),
                    EditorView.theme({
                        "&": {
                            height: "100%",
                            color: "var(--vscode-editor-foreground)",
                            backgroundColor: "var(--vscode-editor-background)",
                        },
                        ".cm-scroller": {
                            overflow: "auto",
                            fontFamily: "var(--vscode-editor-font-family, monospace)",
                            fontSize: "13px",
                        },
                        ".cm-gutters": {
                            backgroundColor: "var(--vscode-editor-background)",
                            color: "var(--vscode-editor-foreground)",
                            border: "none",
                        },
                    }),
                ],
            }),
        });
        editor.current = view;
        const observer = new MutationObserver(() =>
            view.dispatch({ effects: setMergeSyntax.of(detectTheme()) }),
        );
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style"],
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
        return () => {
            observer.disconnect();
            view.destroy();
            editor.current = null;
        };
    }, [filePath]);
    useEffect(() => {
        const view = editor.current;
        if (view && view.state.doc.toString() !== content) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        }
    }, [content]);
    return <div ref={root} className="partial-preview" />;
}

/** Virtual rows keep even large ordinary-text diffs bounded in DOM size. */
function PartialDiff({
    blocks,
    selected,
    toggle,
    disabled,
}: {
    blocks: ChangeBlock[];
    selected: ReadonlySet<string>;
    toggle: (ids: string[]) => void;
    disabled: boolean;
}) {
    const root = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(600);
    const rows = useMemo<DiffRow[]>(
        () =>
            blocks.flatMap((block) => [
                { kind: "block" as const, block },
                ...block.lines.map((line) => ({ kind: "line" as const, line })),
            ]),
        [blocks],
    );
    useEffect(() => {
        if (!root.current) return;
        const measure = () => setHeight(root.current?.clientHeight || 600);
        measure();
        const observer =
            typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
        observer?.observe(root.current);
        return () => observer?.disconnect();
    }, []);
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8);
    const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 8);
    return (
        <div
            ref={root}
            className="partial-diff-scroll"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
            <div className="partial-diff-rows" style={{ height: rows.length * ROW_HEIGHT }}>
                {rows.slice(start, end).map((row, offset) => {
                    const index = start + offset;
                    if (row.kind === "block") {
                        const ids = changeIds([row.block]);
                        const count = ids.filter((id) => selected.has(id)).length;
                        return (
                            <div
                                key={`block-${row.block.id}`}
                                className="partial-block"
                                style={{ top: index * ROW_HEIGHT }}
                            >
                                <VscCheckbox
                                    ariaLabel={`${t("changes.selectBlock")} ${row.block.id}`}
                                    isChecked={count === ids.length}
                                    isIndeterminate={count > 0 && count < ids.length}
                                    disabled={disabled}
                                    onChange={() => toggle(ids)}
                                />
                                <span>{`@@ -${row.block.oldStart},${row.block.oldCount} +${row.block.newStart},${row.block.newCount} @@`}</span>
                            </div>
                        );
                    }
                    const line = row.line;
                    return (
                        <div
                            key={line.id}
                            className={`partial-line partial-line-${line.kind}`}
                            style={{ top: index * ROW_HEIGHT }}
                            data-change-id={line.id}
                            data-change-kind={line.kind}
                        >
                            <span className="partial-check">
                                {line.kind !== "context" ? (
                                    <VscCheckbox
                                        ariaLabel={`${t("changes.includeLine")} ${line.id}`}
                                        isChecked={selected.has(line.id)}
                                        disabled={disabled}
                                        onChange={() => toggle([line.id])}
                                    />
                                ) : null}
                            </span>
                            <span className="partial-number">{line.oldLine ?? ""}</span>
                            <span className="partial-number">{line.newLine ?? ""}</span>
                            <span className="partial-sign">
                                {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}
                            </span>
                            <code>{line.text.replace(/\n$/, "").replace(/\r$/, "")}</code>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** Announces stale ownership and inclusion separately so an explicit empty selection is never mistaken for an unselected file. */
function PartialStatus({ data, error }: { data: FileData | null; error: string }) {
    const ownership = data?.lists.changes[data.file.path];
    const inclusion =
        data?.file.side === "working" ? ownership?.selections?.[data.listId] : undefined;
    return (
        <>
            {error ? (
                <div className="partial-status" role="alert">
                    {error}
                </div>
            ) : null}
            {/* With one list every line already belongs to it, so there is nothing to review. */}
            {ownership?.stale && (data?.lists.lists.length ?? 0) > 1 ? (
                <div className="partial-status" role="status">
                    {t("changes.reviewAssignments")}
                </div>
            ) : null}
            {inclusion && (inclusion.reviewRequired || inclusion.contentId !== data?.contentId) ? (
                <div className="partial-status" role="status">
                    {t("changes.reviewSelection")}
                </div>
            ) : null}
        </>
    );
}

/** Resolve inclusion conservatively; a review fence takes precedence over a pane's local cache. */
function initialSelection(
    reply: FileData,
    available: ReadonlySet<string>,
    restore?: string[],
): string[] {
    const selection =
        reply.file.side === "working"
            ? reply.lists.changes[reply.file.path]?.selections?.[reply.listId]
            : undefined;
    if (selection?.reviewRequired) return [];
    if (restore) return restore;
    if (selection) return selection.contentId === reply.contentId ? selection.lineIds : [];
    if (reply.file.side === "index" || reply.listId === "all") return [...available];
    return reply.file.blocks
        .flatMap((block) => block.lines)
        .filter(
            (line) =>
                line.kind !== "context" &&
                (reply.lists.changes[reply.file.path]?.lines[line.fingerprint] ??
                    reply.lists.files[reply.file.path] ??
                    reply.lists.activeId) === reply.listId,
        )
        .map((line) => line.id);
}

/** Keeps save/export separate from removal and disables destructive actions outside working changes. */
function SelectedShelfActions({
    available,
    mutable,
    assignable,
    send,
}: {
    available: boolean;
    mutable: boolean;
    assignable: boolean;
    send: (
        type: "saveSelection" | "shelveSelection" | "rollbackSelection" | "exportSelection",
    ) => void;
}) {
    if (!available) return null;
    return (
        <>
            <button disabled={!mutable} onClick={() => send("exportSelection")}>
                {t("changes.exportPatch")}
            </button>
            <button disabled={!mutable} onClick={() => send("saveSelection")}>
                {t("shelf.action.save")}
            </button>
            <button disabled={!assignable} onClick={() => send("shelveSelection")}>
                {t("changes.saveAndRemoveSelection")}
            </button>
            <button disabled={!assignable} onClick={() => send("rollbackSelection")}>
                {t("changes.rollbackSelection")}
            </button>
        </>
    );
}

/** Assigning lines needs somewhere else to send them, so one list shows no assign controls. */
function AssignActions({
    lists,
    targetList,
    assignable,
    onTargetChange,
    onAssign,
}: {
    lists: readonly { id: string; name: string }[];
    targetList: string;
    assignable: boolean;
    onTargetChange: (id: string) => void;
    onAssign: () => void;
}) {
    if (lists.length < 2) return null;
    return (
        <>
            <select
                aria-label={t("changes.targetList")}
                value={targetList}
                disabled={!assignable}
                onChange={(event) => onTargetChange(event.currentTarget.value)}
            >
                {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                        {list.name}
                    </option>
                ))}
            </select>
            <button disabled={!assignable} onClick={onAssign}>
                <VscArrowRight />
                {t("changes.assign")}
            </button>
        </>
    );
}

/** Presents immutable host snapshots; only identities and explicit selections are sent back. */
export function PartialChangesApp() {
    const api = getVsCodeApi<PartialEditorOutbound, SavedSelection>();
    const [data, setData] = useState<FileData | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [side, setSide] = useState<"working" | "index">("working");
    const [targetList, setTargetList] = useState("default");
    const [message, setMessage] = useState(() => api.getState()?.message ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [commit, setCommit] = useState("");
    const [operationMessage, setOperationMessage] = useState("");
    const [removed, setRemoved] = useState(false);
    const current = useRef<FileData | null>(null);
    const currentSelected = useRef(selected);
    useLayoutEffect(() => {
        currentSelected.current = selected;
    }, [selected]);
    useEffect(() => {
        const receive = (event: MessageEvent<PartialEditorReply>) => {
            const reply = event.data;
            if (reply.type === "partialFile") {
                const available = new Set(changeIds(reply.file.blocks));
                const saved = api.getState();
                const previous = current.current;
                const restore =
                    previous?.contentId === reply.contentId
                        ? [...currentSelected.current]
                        : saved?.contentId === reply.contentId
                          ? saved.ids
                          : undefined;
                const initial = initialSelection(reply, available, restore);
                setSelected(new Set(initial.filter((id) => available.has(id))));
                setData(reply);
                current.current = reply;
                setTargetList(
                    reply.lists.lists.some((list) => list.id === reply.listId)
                        ? reply.listId
                        : reply.lists.activeId,
                );
                setSide(reply.file.side);
                setBusy(false);
                setError("");
            } else if (reply.type === "partialError") {
                setError(reply.message);
                setBusy(false);
            } else if (reply.type === "partialCommitted") {
                setCommit(reply.commit);
                setBusy(false);
            } else if (reply.type === "partialOperationCompleted") {
                setOperationMessage(reply.message);
                setRemoved(reply.removed);
                setBusy(false);
            }
        };
        window.addEventListener("message", receive);
        api.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", receive);
    }, [api]);
    useEffect(() => {
        const timer = window.setTimeout(
            () =>
                api.setState({
                    contentId: data?.contentId,
                    ids: [...selected],
                    message,
                }),
            150,
        );
        return () => window.clearTimeout(timer);
    }, [api, data?.contentId, message, selected]);
    const deferred = useDeferredValue(selected);
    const preview = useMemo(() => {
        if (!data) return "";
        return selectedContent(data.file.base, data.file.blocks, [...deferred]);
    }, [data, deferred]);
    const toggle = (ids: string[]) => {
        setSelected((previous) => {
            const next = new Set(previous);
            const remove = ids.every((id) => next.has(id));
            for (const id of ids) {
                if (remove) next.delete(id);
                else next.add(id);
            }
            return next;
        });
    };
    const send = (kind: "stage" | "commit" | "assign" | "use") => {
        if (!data || busy || commit || removed || !selected.size) return;
        const selection = { snapshotId: data.file.snapshotId, lineIds: [...selected] };
        setBusy(true);
        setError("");
        if (kind === "use") api.postMessage({ type: "useSelection", selection });
        else if (kind === "stage") api.postMessage({ type: "stageSelection", selection });
        else if (kind === "commit")
            api.postMessage({ type: "commitSelection", selection, message });
        else
            api.postMessage({
                type: "assignSelection",
                selection,
                listId: targetList,
                revision: data.lists.revision,
            });
    };
    const selectedOperation = (
        type: "saveSelection" | "shelveSelection" | "rollbackSelection" | "exportSelection",
    ) => {
        if (!data?.selectedOperations || !mutable) return;
        setBusy(true);
        setError("");
        api.postMessage({
            type,
            selection: { snapshotId: data.file.snapshotId, lineIds: [...selected] },
        });
    };
    const locked = busy || commit.length > 0 || removed;
    const mutable = !locked && selected.size > 0;
    const assignable = mutable && side === "working";
    const committable = mutable && message.trim().length > 0 && deferred === selected;
    return (
        <main className="partial-changes">
            <header className="partial-toolbar">
                <strong title={data?.file.path}>{data?.file.path ?? t("changes.partial")}</strong>
                <select
                    aria-label={t("changes.source")}
                    value={side}
                    disabled={locked}
                    onChange={(event) => {
                        const value = event.currentTarget.value as "working" | "index";
                        setBusy(true);
                        api.postMessage({ type: "ready", side: value });
                    }}
                >
                    <option value="working">{t("changes.working")}</option>
                    <option value="index">{t("changes.index")}</option>
                </select>
                <button
                    title={t("changes.reload")}
                    aria-label={t("changes.reload")}
                    disabled={locked}
                    onClick={() => {
                        setBusy(true);
                        api.postMessage({ type: "ready", side });
                    }}
                >
                    <VscRefresh />
                </button>
                <button
                    title={t("changes.fullDiff")}
                    aria-label={t("changes.fullDiff")}
                    onClick={() => api.postMessage({ type: "openNative" })}
                >
                    <VscDiff />
                </button>
            </header>
            <PartialStatus data={data} error={error} />
            <div className="partial-panes">
                <section className="partial-pane">
                    <div className="partial-pane-title">
                        {data ? (
                            <VscCheckbox
                                ariaLabel={t("changes.selectAll")}
                                isChecked={selected.size === changeIds(data.file.blocks).length}
                                isIndeterminate={
                                    selected.size > 0 &&
                                    selected.size < changeIds(data.file.blocks).length
                                }
                                disabled={locked}
                                onChange={() => toggle(changeIds(data.file.blocks))}
                            />
                        ) : null}
                        <span>{t("changes.selected")}</span>
                        <span>{selected.size}</span>
                    </div>
                    {data && data.file.blocks.length === 0 ? (
                        <div role="status">{t("changes.noChanges")}</div>
                    ) : data ? (
                        <PartialDiff
                            blocks={data.file.blocks}
                            selected={selected}
                            toggle={toggle}
                            disabled={locked}
                        />
                    ) : (
                        <div role="status">{t("changes.loading")}</div>
                    )}
                </section>
                <section className="partial-pane">
                    <div className="partial-pane-title">{t("changes.preview")}</div>
                    <SelectionPreview content={preview} filePath={data?.file.path ?? ""} />
                </section>
            </div>
            <footer className="partial-footer">
                <div className="partial-actions">
                    <SelectedShelfActions
                        available={data?.selectedOperations === true}
                        mutable={mutable}
                        assignable={assignable}
                        send={selectedOperation}
                    />
                    <AssignActions
                        lists={data?.lists.lists ?? []}
                        targetList={targetList}
                        assignable={assignable}
                        onTargetChange={setTargetList}
                        onAssign={() => send("assign")}
                    />
                    <button disabled={!assignable} onClick={() => send("use")}>
                        <VscCheck />
                        {t("changes.useSelection")}
                    </button>
                    <button disabled={!mutable} onClick={() => send("stage")}>
                        {side === "working" ? <VscArrowUp /> : <VscArrowDown />}
                        {side === "working" ? t("changes.stage") : t("changes.unstage")}
                    </button>
                </div>
                <textarea
                    aria-label={t("changes.commitMessage")}
                    value={message}
                    disabled={locked}
                    onChange={(event) => setMessage(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        if (
                            (event.ctrlKey || event.metaKey) &&
                            event.key === "Enter" &&
                            message.trim()
                        ) {
                            event.preventDefault();
                            send("commit");
                        }
                    }}
                />
                <div className="partial-commit">
                    <span role="status">
                        {commit
                            ? `${t("changes.committed")} ${commit.slice(0, 8)}`
                            : busy
                              ? t("changes.pending")
                              : operationMessage}
                    </span>
                    <button disabled={!committable} onClick={() => send("commit")}>
                        <VscCheck />
                        {t("changes.commit")}
                    </button>
                </div>
            </footer>
        </main>
    );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<PartialChangesApp />);
