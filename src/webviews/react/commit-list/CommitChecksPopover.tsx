import React from "react";
import { createPortal } from "react-dom";
import { FiCheckCircle, FiLoader, FiMinusCircle } from "react-icons/fi";
import { IoIosCloseCircleOutline } from "react-icons/io";
import type { CommitChecksSnapshot, CommitCheckState } from "../../../types";
import { t } from "../shared/i18n";
import { JETBRAINS_UI } from "../shared/tokens";

/** Commit-check data cached by hash, including the in-flight marker used while GitHub responds. */
export type CommitChecksValue = CommitChecksSnapshot | "loading";

interface Props {
    hash: string;
    checks?: CommitChecksValue;
    onRequestChecks: (hash: string) => void;
    onOpenCheckUrl: (url: string) => void;
}

const PANEL_WIDTH = 600;
const PANEL_MAX_HEIGHT = 360;
const SPINNER_STYLE_ID = "intelligit-commit-check-spinner";
const SPINNER_STYLE_RULES = `
@keyframes intelligit-commit-check-spin {
    to { transform: rotate(360deg); }
}
`;

/** Renders the commit-row GitHub checks icon and its floating result popover. */
export function CommitChecksButton({
    hash,
    checks,
    onRequestChecks,
    onOpenCheckUrl,
}: Props): React.ReactElement | null {
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const panelRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState<{
        left: number;
        top: number;
        placement: "above" | "below";
    } | null>(null);

    React.useInsertionEffect(() => {
        if (typeof document === "undefined") return;
        if (document.getElementById(SPINNER_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = SPINNER_STYLE_ID;
        style.textContent = SPINNER_STYLE_RULES;
        document.head.appendChild(style);
    }, []);

    const state = checks && checks !== "loading" ? checks.state : "pending";
    const buttonLabel = t("commit.checks.title");
    const buttonTitle = checks && checks !== "loading" ? checks.summary : buttonLabel;

    const openPanel = (): void => {
        const button = buttonRef.current;
        if (!button) return;
        const rect = button.getBoundingClientRect();
        const placement =
            rect.bottom + PANEL_MAX_HEIGHT + 10 < window.innerHeight ? "below" : "above";
        const panelWidth = Math.min(PANEL_WIDTH, window.innerWidth - 16);
        const panelHeight = Math.min(PANEL_MAX_HEIGHT, Math.max(0, window.innerHeight - 16));
        setPosition({
            left: Math.min(
                Math.max(8, rect.right - panelWidth),
                window.innerWidth - panelWidth - 8,
            ),
            top: placement === "below" ? rect.bottom + 6 : Math.max(panelHeight + 8, rect.top - 6),
            placement,
        });
        if (!checks) onRequestChecks(hash);
    };

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        if (position) {
            setPosition(null);
            return;
        }
        openPanel();
    };

    React.useEffect(() => {
        if (!position) return;
        const closeOnOutsidePointer = (event: PointerEvent): void => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setPosition(null);
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setPosition(null);
        };
        document.addEventListener("pointerdown", closeOnOutsidePointer);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutsidePointer);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [position]);

    if (checks && checks !== "loading" && checks.state === "none" && checks.items.length === 0) {
        return null;
    }

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                title={buttonTitle}
                aria-label={buttonLabel}
                onClick={handleClick}
                style={buttonStyle}
                data-testid={`commit-checks-button-${hash}`}
            >
                <StateIcon state={state} />
            </button>
            {position &&
                createPortal(
                    <CommitChecksPanel
                        panelRef={panelRef}
                        checks={checks}
                        position={position}
                        onOpenCheckUrl={onOpenCheckUrl}
                    />,
                    document.body,
                )}
        </>
    );
}

function CommitChecksPanel({
    panelRef,
    checks,
    position,
    onOpenCheckUrl,
}: {
    panelRef: React.RefObject<HTMLDivElement>;
    checks?: CommitChecksValue;
    position: { left: number; top: number; placement: "above" | "below" };
    onOpenCheckUrl: (url: string) => void;
}): React.ReactElement {
    const snapshot = checks && checks !== "loading" ? checks : undefined;
    return (
        <div
            ref={panelRef}
            style={{
                ...panelStyle,
                left: position.left,
                top: position.top,
                transform: position.placement === "above" ? "translateY(-100%)" : undefined,
            }}
            onClick={(event) => event.stopPropagation()}
        >
            <div style={titleStyle}>{t("commit.checks.title")}</div>
            <div style={bodyStyle}>
                {checks === "loading" || !checks ? (
                    <div style={emptyStyle}>{t("commit.checks.loading")}</div>
                ) : snapshot && snapshot.items.length > 0 ? (
                    snapshot.items.map((item, index) => {
                        const itemUrl = item.url;
                        return (
                            <div key={`${item.source}:${item.name}:${index}`} style={rowStyle}>
                                <StateIcon state={item.state} />
                                <div style={rowTextStyle}>
                                    {itemUrl ? (
                                        <button
                                            type="button"
                                            style={linkButtonStyle}
                                            onClick={() => onOpenCheckUrl(itemUrl)}
                                        >
                                            {item.name}
                                        </button>
                                    ) : (
                                        <span style={nameStyle}>{item.name}</span>
                                    )}
                                    {item.description ? (
                                        <span style={descriptionStyle}>{item.description}</span>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div style={emptyStyle}>
                        {snapshot?.error ?? snapshot?.summary ?? t("commit.checks.none")}
                    </div>
                )}
            </div>
        </div>
    );
}

function StateIcon({ state }: { state?: CommitCheckState }): React.ReactElement {
    const color = colorForState(state);
    const style: React.CSSProperties = { color, flexShrink: 0 };
    if (state === "failure" || state === "timed_out" || state === "action_required") {
        return <IoIosCloseCircleOutline size={18} aria-hidden="true" style={style} />;
    }
    if (state === "pending") {
        return (
            <FiLoader
                size={16}
                aria-hidden="true"
                style={{
                    ...style,
                    animation: "intelligit-commit-check-spin 1s linear infinite",
                }}
            />
        );
    }
    if (state === "skipped" || state === "cancelled" || state === "neutral") {
        return <FiMinusCircle size={16} aria-hidden="true" style={style} />;
    }
    return <FiCheckCircle size={16} aria-hidden="true" style={style} />;
}

function colorForState(state?: CommitCheckState): string {
    switch (state) {
        case "success":
            return "var(--vscode-charts-green, #62c370)";
        case "failure":
        case "timed_out":
        case "action_required":
            return "var(--vscode-errorForeground, #f14c4c)";
        case "pending":
            return "var(--vscode-charts-yellow, #e5c07b)";
        case "skipped":
        case "cancelled":
        case "neutral":
            return "var(--vscode-charts-blue, #7aa2f7)";
        default:
            return "var(--vscode-descriptionForeground, #9ca6b8)";
    }
}

const buttonStyle: React.CSSProperties = {
    width: 24,
    height: 24,
    border: "none",
    background: "transparent",
    color: JETBRAINS_UI.color.muted,
    padding: 0,
    marginLeft: 4,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flexShrink: 0,
};

const panelStyle: React.CSSProperties = {
    position: "fixed",
    width: PANEL_WIDTH,
    maxWidth: "calc(100vw - 16px)",
    maxHeight: `min(${PANEL_MAX_HEIGHT}px, calc(100vh - 16px))`,
    overflow: "hidden",
    background: JETBRAINS_UI.color.panel,
    color: JETBRAINS_UI.color.foreground,
    border: `1px solid ${JETBRAINS_UI.color.tooltipBorder}`,
    borderRadius: 8,
    boxShadow: "0 18px 46px rgba(0,0,0,0.5)",
    zIndex: 10000,
};

const titleStyle: React.CSSProperties = {
    padding: "12px 14px",
    textAlign: "center",
    fontSize: 13,
    fontWeight: 700,
    background: JETBRAINS_UI.color.panel,
    color: JETBRAINS_UI.color.muted,
};

const bodyStyle: React.CSSProperties = {
    padding: "14px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 11,
    maxHeight: 250,
    overflow: "auto",
};

const rowStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
};

const rowTextStyle: React.CSSProperties = {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
};

const linkButtonStyle: React.CSSProperties = {
    border: "none",
    background: "transparent",
    color: "var(--vscode-textLink-foreground, #4ea1ff)",
    padding: 0,
    textAlign: "left",
    fontSize: 13,
    cursor: "pointer",
};

const nameStyle: React.CSSProperties = {
    color: "var(--vscode-textLink-foreground, #4ea1ff)",
    fontSize: 13,
};

const descriptionStyle: React.CSSProperties = {
    color: JETBRAINS_UI.color.muted,
    fontSize: 12,
    lineHeight: "16px",
};

const emptyStyle: React.CSSProperties = {
    color: JETBRAINS_UI.color.muted,
    fontSize: 12,
};
