import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VscEllipsis, VscListSelection, VscRefresh, VscSearch } from "react-icons/vsc";
import { DiffViewer } from "../diff-viewer/DiffViewer";
import { CommitMessageCell } from "../commit-list/CommitRow";
import { ContextMenu } from "../shared/components/ContextMenu";
import { t } from "../shared/i18n";
import { useFileHistory } from "./useFileHistory";
import "./file-history.css";

/** Renders a compact selectable revision list beside the existing shared diff viewer. */
export function App(): React.ReactElement {
    const history = useFileHistory();
    const [search, setSearch] = useState("");
    const [details, setDetails] = useState(false);
    const [searchVisible, setSearchVisible] = useState(false);
    const [width, setWidth] = useState(41);
    const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null);
    const anchor = useRef<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const layoutRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const { state, selected, loading } = history;
    useEffect(() => {
        if (!menu) return;
        const items = Array.from(
            document.querySelectorAll<HTMLElement>('[role="menuitem"][data-disabled="false"]'),
        );
        items[0]?.focus();
        /** Supplies arrow navigation for this menu without changing the shared component. */
        const navigateMenu = (event: KeyboardEvent) => {
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !items.length)
                return;
            if (!items.includes(document.activeElement as HTMLElement)) return;
            event.preventDefault();
            const current = items.indexOf(document.activeElement as HTMLElement);
            const index =
                event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                        items.length;
            items[index].focus();
        };
        document.addEventListener("keydown", navigateMenu);
        return () => document.removeEventListener("keydown", navigateMenu);
    }, [menu]);
    useEffect(() => {
        if (searchVisible) searchRef.current?.focus();
    }, [searchVisible]);
    if (!state)
        return (
            <div className="file-history-placeholder" role={history.error ? "alert" : "status"}>
                {history.error ?? t("diff.loading")}
            </div>
        );
    const labels = state.labels;
    const query = search.toLocaleLowerCase();
    const entries = state.entries.filter((entry) =>
        `${entry.subject} ${entry.authorName} ${entry.hash}`.toLocaleLowerCase().includes(query),
    );
    const active = state.entries.find((entry) => entry.hash === selected[0]);

    /** Applies range or toggle selection in displayed history order, without inventing ancestry. */
    const selectRow = (
        index: number,
        modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
    ) => {
        const entry = entries[index];
        if (!entry) return;
        setMenu(null);
        const anchorIndex = entries.findIndex((item) => item.hash === anchor.current);
        let hashes = [entry.hash];
        if (modifiers.shiftKey && anchorIndex >= 0) {
            hashes = entries
                .slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1)
                .map((item) => item.hash);
        } else if (modifiers.ctrlKey || modifiers.metaKey) {
            const toggled = new Set(selected);
            if (toggled.has(entry.hash)) toggled.delete(entry.hash);
            else toggled.add(entry.hash);
            hashes = entries.filter((item) => toggled.has(item.hash)).map((item) => item.hash);
            anchor.current = entry.hash;
        } else anchor.current = entry.hash;
        history.select(hashes);
    };

    /** Moves focus and selection through the visible list, extending from the selection anchor. */
    const navigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const options = Array.from(
            listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
        );
        const focused = options.findIndex((option) => option === document.activeElement);
        const current =
            focused >= 0 ? focused : entries.findIndex((entry) => selected.includes(entry.hash));
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? entries.length - 1
                  : Math.max(
                        0,
                        Math.min(
                            entries.length - 1,
                            current + (event.key === "ArrowDown" ? 1 : -1),
                        ),
                    );
        selectRow(index, event);
        options[index]?.focus();
    };

    /** Keeps both panels usable while translating pointer position to a container-relative split. */
    const resize = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = layoutRef.current?.getBoundingClientRect();
        if (bounds?.width)
            setWidth(
                Math.max(25, Math.min(70, ((event.clientX - bounds.left) / bounds.width) * 100)),
            );
    };

    /** Restores focus to the control or revision that opened the shared menu. */
    const closeMenu = () => {
        menu?.trigger.focus();
        setMenu(null);
    };

    /** A row context menu targets that row unless it belongs to the existing range. */
    const openRowMenu = (index: number, trigger: HTMLElement, x: number, y: number) => {
        if (!selected.includes(entries[index].hash))
            selectRow(index, { shiftKey: false, ctrlKey: false, metaKey: false });
        setMenu({ x, y, trigger });
    };

    return (
        <main className="file-history">
            <div
                className="file-history-layout"
                ref={layoutRef}
                style={{ gridTemplateColumns: `${width}% 4px minmax(0, 1fr)` }}
            >
                <section className="file-history-list-panel">
                    <header className="file-history-toolbar">
                        <label className="file-history-branch">
                            <span>{labels.branch}:</span>
                            <select
                                aria-label={labels.branch}
                                title={state.ref}
                                value={state.ref}
                                disabled={loading}
                                onChange={(event) => {
                                    setSearch("");
                                    setMenu(null);
                                    anchor.current = null;
                                    history.refresh(event.target.value);
                                }}
                            >
                                {[...new Set(["HEAD", state.ref, ...state.branches])].map(
                                    (branch) => (
                                        <option key={branch} value={branch}>
                                            {branch}
                                        </option>
                                    ),
                                )}
                            </select>
                        </label>
                        <button
                            type="button"
                            aria-label={labels.refresh}
                            title={labels.refresh}
                            disabled={loading}
                            onClick={() => {
                                setMenu(null);
                                history.refresh(state.ref);
                            }}
                        >
                            <VscRefresh aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            aria-label={labels.details}
                            title={labels.details}
                            aria-pressed={details}
                            onClick={() => setDetails(!details)}
                        >
                            <VscListSelection aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            aria-label={labels.search}
                            title={labels.search}
                            aria-expanded={searchVisible}
                            aria-controls="file-history-search"
                            onClick={() => {
                                setSearchVisible(!searchVisible);
                                if (searchVisible) {
                                    setSearch("");
                                    anchor.current = null;
                                }
                            }}
                        >
                            <VscSearch aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            aria-label={labels.actions}
                            title={labels.actions}
                            aria-haspopup="menu"
                            aria-expanded={!!menu}
                            disabled={loading}
                            onMouseDown={(event) => {
                                // Let this button's click close the menu before the outside-click listener can reopen it.
                                if (menu) event.stopPropagation();
                            }}
                            onClick={(event) => {
                                if (menu) closeMenu();
                                else {
                                    const bounds = event.currentTarget.getBoundingClientRect();
                                    setMenu({
                                        x: bounds.left,
                                        y: bounds.bottom,
                                        trigger: event.currentTarget,
                                    });
                                }
                            }}
                        >
                            <VscEllipsis aria-hidden="true" />
                        </button>
                    </header>
                    {searchVisible ? (
                        <div className="file-history-search">
                            <input
                                id="file-history-search"
                                aria-label={labels.search}
                                placeholder={labels.search}
                                value={search}
                                ref={searchRef}
                                onChange={(event) => {
                                    setSearch(event.target.value);
                                    setMenu(null);
                                    anchor.current = null;
                                    history.select([]);
                                }}
                            />
                        </div>
                    ) : null}
                    {history.error ? (
                        <div className="file-history-error" role="alert">
                            {history.error}
                        </div>
                    ) : null}
                    <div
                        className="file-history-list"
                        role="listbox"
                        aria-label={state.path}
                        aria-multiselectable="true"
                        aria-busy={loading}
                        ref={listRef}
                        onKeyDown={navigate}
                    >
                        {loading ? (
                            <div className="file-history-placeholder" role="status">
                                {t("diff.loading")}
                            </div>
                        ) : (
                            entries.map((entry, index) => (
                                <div
                                    key={entry.hash}
                                    role="option"
                                    aria-selected={selected.includes(entry.hash)}
                                    tabIndex={
                                        selected[0] === entry.hash ||
                                        (!selected.length && index === 0)
                                            ? 0
                                            : -1
                                    }
                                    className="file-history-row"
                                    onClick={(event) => selectRow(index, event)}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        openRowMenu(
                                            index,
                                            event.currentTarget,
                                            event.clientX,
                                            event.clientY,
                                        );
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === " " || event.key === "Enter") {
                                            event.preventDefault();
                                            selectRow(index, event);
                                        } else if (
                                            event.key === "ContextMenu" ||
                                            (event.shiftKey && event.key === "F10")
                                        ) {
                                            event.preventDefault();
                                            const bounds =
                                                event.currentTarget.getBoundingClientRect();
                                            openRowMenu(
                                                index,
                                                event.currentTarget,
                                                bounds.left,
                                                bounds.bottom,
                                            );
                                        }
                                    }}
                                    title={`${entry.hash}\n${entry.subject}`}
                                >
                                    <span title={entry.authorEmail}>{entry.authorName}</span>
                                    <time dateTime={entry.authoredAt}>
                                        {new Date(entry.authoredAt).toLocaleString(undefined, {
                                            year: "2-digit",
                                            month: "numeric",
                                            day: "numeric",
                                            hour: "numeric",
                                            minute: "2-digit",
                                        })}
                                    </time>
                                    <svg
                                        className="file-history-graph"
                                        width="20"
                                        height="24"
                                        viewBox="0 0 20 24"
                                        aria-hidden="true"
                                    >
                                        {/* Only verified adjacent raw-parent relationships share a graph line. */}
                                        {index > 0 &&
                                        entries[index - 1].parents.includes(entry.hash) ? (
                                            <line x1="10" y1="0" x2="10" y2="12" />
                                        ) : null}
                                        {entries[index + 1] &&
                                        entry.parents.includes(entries[index + 1].hash) ? (
                                            <line x1="10" y1="12" x2="10" y2="24" />
                                        ) : null}
                                        <circle cx="10" cy="12" r="3.5" />
                                    </svg>
                                    <CommitMessageCell
                                        message={entry.subject}
                                        refs={(entry.refs ?? []).map((ref) =>
                                            ref.kind === "tag" ? `tag:${ref.name}` : ref.name,
                                        )}
                                    />
                                </div>
                            ))
                        )}
                        {!loading && !entries.length ? (
                            <div className="file-history-placeholder">{labels.empty}</div>
                        ) : null}
                    </div>
                    {state.hasMore ? (
                        <button
                            className="file-history-more"
                            type="button"
                            disabled={loading}
                            onClick={() => history.postMessage({ type: "historyMore" })}
                        >
                            {labels.more}
                        </button>
                    ) : null}
                    {details && active ? (
                        <section className="file-history-details" aria-label={labels.details}>
                            <strong>{active.subject}</strong>
                            <code>{active.hash}</code>
                            <span>
                                {active.authorName} &lt;{active.authorEmail}&gt;
                            </span>
                            <time dateTime={active.authoredAt}>
                                {new Date(active.authoredAt).toLocaleString()}
                            </time>
                            <span>{active.pathAtRevision}</span>
                        </section>
                    ) : null}
                </section>
                <div
                    className="file-history-divider"
                    role="separator"
                    tabIndex={0}
                    aria-label={labels.resize}
                    aria-orientation="vertical"
                    aria-valuemin={25}
                    aria-valuemax={70}
                    aria-valuenow={width}
                    onPointerDown={(event) =>
                        event.currentTarget.setPointerCapture(event.pointerId)
                    }
                    onPointerMove={resize}
                    onPointerUp={(event) =>
                        event.currentTarget.releasePointerCapture(event.pointerId)
                    }
                    onKeyDown={(event) => {
                        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                            event.preventDefault();
                            setWidth(
                                Math.max(
                                    25,
                                    Math.min(70, width + (event.key === "ArrowRight" ? 2 : -2)),
                                ),
                            );
                        }
                    }}
                />
                <section className="file-history-preview" aria-label={labels.diff}>
                    {selected.length ? (
                        <DiffViewer host={history.host} />
                    ) : (
                        <div className="file-history-placeholder">{labels.select}</div>
                    )}
                </section>
            </div>
            {menu && !loading ? (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    items={(["copy", "open", "diff", "affected", "local"] as const).map(
                        (action) => ({
                            action,
                            label: labels[action],
                            disabled: selected.length !== 1,
                        }),
                    )}
                    onClose={closeMenu}
                    onSelect={(action) => {
                        if (!active || selected.length !== 1) return;
                        if (action === "local") history.select(selected, true);
                        else if (
                            action === "copy" ||
                            action === "open" ||
                            action === "diff" ||
                            action === "affected"
                        )
                            history.postMessage({
                                type: "historyAction",
                                action,
                                hash: active.hash,
                            });
                    }}
                />
            ) : null}
        </main>
    );
}

const container = document.getElementById("root");
/** Exposes teardown for owners importing the entry more than once, including integration tests. */
// react-doctor-disable-next-line react-doctor/only-export-components
export const root = container ? createRoot(container) : null;
root?.render(<App />);
