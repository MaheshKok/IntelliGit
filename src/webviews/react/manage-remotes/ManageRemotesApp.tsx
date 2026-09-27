import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isValidRemoteName } from "../../../utils/gitRefs";
import type {
    ManagedRemote,
    ManageRemotesRequest,
    ManageRemotesResponse,
} from "../../protocol/manageRemotesTypes";
import { t } from "../shared/i18n";
import { getVsCodeApi } from "../shared/vscodeApi";
import "./ManageRemotesApp.css";

interface RemoteForm {
    mode: "add" | "edit";
    revision: number;
    originalName?: string;
    name: string;
    url: string;
    additionalUrlCount: number;
}

/** Mirrors the host's supported name and URL shape before enabling Save. */
function isReadyToSave(form: RemoteForm | null): boolean {
    if (!form || /[\0\r\n]/.test(form.name) || !isValidRemoteName(form.name.trim())) return false;
    return !!form.url.trim() && !/[\0\r\n]/.test(form.url);
}

/** Draws native-style toolbar actions without depending on an unavailable icon font. */
function ActionIcon({ kind }: { kind: "add" | "remove" | "edit" }): React.ReactElement {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {kind === "add" && <path d="M8 3v10M3 8h10" />}
            {kind === "remove" && <path d="M3 8h10" />}
            {kind === "edit" && (
                <>
                    <path d="m3 11.5 7.9-7.9 1.5 1.5-7.9 7.9-2 .5.5-2Z" />
                    <path d="m10.9 3.6 1-1a1 1 0 0 1 1.5 0l.1.1a1 1 0 0 1 0 1.5l-1 1" />
                </>
            )}
        </svg>
    );
}

/** Renders the repository-bound Git Remotes table and its in-place Define Remote form. */
// Webview entrypoint owns root render side effects; Fast Refresh component-export rule is not applicable here.
// react-doctor-disable-next-line react-doctor/only-export-components
export function ManageRemotesApp(): React.ReactElement {
    const api = useMemo(() => getVsCodeApi<ManageRemotesRequest, unknown>(), []);
    const [snapshot, setSnapshot] = useState<Extract<
        ManageRemotesResponse,
        { type: "snapshot" }
    > | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedName, setSelectedName] = useState<string | null>(null);
    const [form, setForm] = useState<RemoteForm | null>(null);
    const nameInput = useRef<HTMLInputElement>(null);
    const trigger = useRef<HTMLButtonElement | null>(null);
    const formRevision = useRef<number | undefined>(undefined);
    const restoreFocus = useRef(false);

    useEffect(() => {
        const onMessage = (event: MessageEvent<ManageRemotesResponse>) => {
            const data = event.data;
            if (data.type === "busy") {
                setBusy(true);
            } else if (data.type === "error") {
                setError(data.message);
                setBusy(false);
            } else if (data.type === "snapshot") {
                setSnapshot(data);
                setBusy(false);
                const staleForm =
                    formRevision.current !== undefined &&
                    formRevision.current !== data.revision &&
                    !data.completed;
                setError(data.error ?? (staleForm ? t("manageRemotes.staleForm") : null));
                if (staleForm || data.completed) {
                    formRevision.current = undefined;
                    restoreFocus.current = true;
                    setForm(null);
                }
            }
        };
        window.addEventListener("message", onMessage);
        api.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", onMessage);
    }, [api]);

    const formMode = form?.mode;
    useEffect(() => {
        if (formMode) nameInput.current?.focus();
    }, [formMode]);

    useEffect(() => {
        if (!form && !busy && restoreFocus.current) {
            restoreFocus.current = false;
            trigger.current?.focus();
        }
    }, [form, busy]);

    useEffect(() => {
        if (!form) return;
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                setForm(null);
                formRevision.current = undefined;
                restoreFocus.current = true;
            }
        };
        document.addEventListener("keydown", onEscape);
        return () => document.removeEventListener("keydown", onEscape);
    }, [form]);

    const remotes = snapshot?.remotes ?? [];
    const selected = remotes.find((remote) => remote.name === selectedName);
    const normalizedName = form?.name.trim() ?? "";
    const normalizedUrl = form?.url.trim() ?? "";
    const validForm = isReadyToSave(form);

    /** Opens a child form while retaining focus restoration to its toolbar action. */
    const begin = (mode: "add" | "edit", button: HTMLButtonElement) => {
        if (!snapshot) return;
        trigger.current = button;
        formRevision.current = snapshot.revision;
        if (mode === "edit" && selected) {
            setForm({
                mode,
                revision: snapshot.revision,
                originalName: selected.name,
                name: selected.name,
                url: selected.url,
                additionalUrlCount: selected.additionalUrlCount,
            });
        } else if (mode === "add") {
            setForm({
                mode,
                revision: snapshot.revision,
                name: "",
                url: "",
                additionalUrlCount: 0,
            });
        }
        setError(null);
    };

    /** Posts only proposed fields and host-issued identity, with no repository path or original URL. */
    const save = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!form || !snapshot || form.revision !== snapshot.revision || !validForm || busy) return;
        setBusy(true);
        if (form.mode === "add") {
            api.postMessage({ type: "add", name: normalizedName, url: normalizedUrl });
        } else if (form.originalName) {
            api.postMessage({
                type: "edit",
                revision: form.revision,
                originalName: form.originalName,
                name: normalizedName,
                url: normalizedUrl,
            });
        }
    };

    /** Selects a row with mouse or keyboard without activating a mutation. */
    const selectByKey = (
        event: React.KeyboardEvent<HTMLTableRowElement>,
        remote: ManagedRemote,
    ) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSelectedName(remote.name);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const index = remotes.findIndex((item) => item.name === remote.name);
            const next = remotes[index + (event.key === "ArrowDown" ? 1 : -1)];
            if (next) {
                setSelectedName(next.name);
                document
                    .querySelector<HTMLTableRowElement>(`[data-remote="${CSS.escape(next.name)}"]`)
                    ?.focus();
            }
        }
    };

    return (
        <main className="manage-remotes">
            <header className="manage-remotes__header">
                <h1>{t("manageRemotes.title")}</h1>
                <span className="manage-remotes__repo" title={snapshot?.repoLabel}>
                    {snapshot?.repoLabel ?? t("manageRemotes.loading")}
                </span>
            </header>
            <div
                className="manage-remotes__toolbar"
                role="toolbar"
                aria-label={t("manageRemotes.actions")}
            >
                <button
                    type="button"
                    className="manage-remotes__icon"
                    aria-label={t("manageRemotes.add")}
                    title={t("manageRemotes.add")}
                    disabled={busy || !snapshot}
                    onClick={(event) => begin("add", event.currentTarget)}
                >
                    <ActionIcon kind="add" />
                </button>
                <button
                    type="button"
                    className="manage-remotes__icon"
                    aria-label={t("manageRemotes.remove")}
                    title={t("manageRemotes.remove")}
                    disabled={busy || !selected || !snapshot}
                    onClick={() => {
                        if (!selected || !snapshot) return;
                        setBusy(true);
                        api.postMessage({
                            type: "remove",
                            revision: snapshot.revision,
                            name: selected.name,
                        });
                    }}
                >
                    <ActionIcon kind="remove" />
                </button>
                <button
                    type="button"
                    className="manage-remotes__icon"
                    aria-label={t("manageRemotes.edit")}
                    title={t("manageRemotes.edit")}
                    disabled={busy || !selected}
                    onClick={(event) => begin("edit", event.currentTarget)}
                >
                    <ActionIcon kind="edit" />
                </button>
            </div>
            <div className="manage-remotes__table-wrap">
                <table role="grid" aria-label={t("manageRemotes.title")}>
                    <thead>
                        <tr>
                            <th scope="col">{t("manageRemotes.name")}</th>
                            <th scope="col">{t("manageRemotes.url")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {remotes.map((remote) => (
                            <tr
                                key={remote.name}
                                role="row"
                                data-remote={remote.name}
                                tabIndex={0}
                                aria-selected={selectedName === remote.name}
                                onClick={() => setSelectedName(remote.name)}
                                onKeyDown={(event) => selectByKey(event, remote)}
                            >
                                <td>{remote.name}</td>
                                <td title={remote.url}>{remote.url}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {snapshot && remotes.length === 0 && (
                    <p className="manage-remotes__empty">{t("manageRemotes.empty")}</p>
                )}
            </div>
            {form && (
                <section
                    className="manage-remotes__form"
                    aria-labelledby="manage-remotes-form-title"
                >
                    <h2 id="manage-remotes-form-title">{t("manageRemotes.defineRemote")}</h2>
                    <form onSubmit={save}>
                        <label htmlFor="manage-remote-name">{t("manageRemotes.name")}</label>
                        <input
                            ref={nameInput}
                            id="manage-remote-name"
                            name="name"
                            value={form.name}
                            disabled={busy}
                            onChange={(event) => setForm({ ...form, name: event.target.value })}
                        />
                        <label htmlFor="manage-remote-url">{t("manageRemotes.url")}</label>
                        <input
                            id="manage-remote-url"
                            name="url"
                            value={form.url}
                            disabled={busy}
                            onChange={(event) => setForm({ ...form, url: event.target.value })}
                        />
                        {form.additionalUrlCount > 0 && (
                            <p className="manage-remotes__note">
                                {t("manageRemotes.additionalUrls", {
                                    count: form.additionalUrlCount,
                                })}
                            </p>
                        )}
                        <div className="manage-remotes__form-actions">
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    setForm(null);
                                    formRevision.current = undefined;
                                    restoreFocus.current = true;
                                }}
                            >
                                {t("manageRemotes.cancel")}
                            </button>
                            <button type="submit" disabled={!validForm || busy}>
                                {t("manageRemotes.save")}
                            </button>
                        </div>
                    </form>
                </section>
            )}
            {error && (
                <div className="manage-remotes__error" role="alert">
                    <span>{error}</span>
                    <button
                        type="button"
                        aria-label={t("manageRemotes.retry")}
                        disabled={busy}
                        onClick={() => {
                            setBusy(true);
                            api.postMessage({ type: "reload" });
                        }}
                    >
                        {t("manageRemotes.retry")}
                    </button>
                </div>
            )}
            <footer className="manage-remotes__footer">
                <button type="button" onClick={() => api.postMessage({ type: "close" })}>
                    {t("manageRemotes.close")}
                </button>
            </footer>
        </main>
    );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<ManageRemotesApp />);
