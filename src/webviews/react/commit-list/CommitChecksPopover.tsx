import React from "react";
import { createPortal } from "react-dom";
import { FiCheckCircle, FiMinusCircle } from "react-icons/fi";
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
    /** Sign in to the snapshot's `signInHost` from the popover (recoverable `unavailable` only). */
    onSignIn?: (host: string) => void;
}

const PANEL_MAX_WIDTH = 420;
const PANEL_TEXT_MAX_WIDTH = 340;
const PANEL_MAX_HEIGHT = 360;

/** Renders the commit-row GitHub checks icon and its floating result popover. */
export function CommitChecksButton({
    hash,
    checks,
    onRequestChecks,
    onOpenCheckUrl,
    onSignIn,
}: Props): React.ReactElement | null {
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const panelRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState<{
        left: number;
        top: number;
        placement: "above" | "below";
    } | null>(null);

    const state = checks && checks !== "loading" ? checks.state : "pending";
    const buttonLabel = t("commit.checks.title");
    const buttonTitle = checks && checks !== "loading" ? checks.summary : buttonLabel;

    const openPanel = (): void => {
        const button = buttonRef.current;
        if (!button) return;
        const rect = button.getBoundingClientRect();
        const placement =
            rect.bottom + PANEL_MAX_HEIGHT + 10 < window.innerHeight ? "below" : "above";
        const panelWidth = Math.min(PANEL_MAX_WIDTH, window.innerWidth - 16);
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
        const closeOnWindowBlur = (): void => setPosition(null);
        document.addEventListener("pointerdown", closeOnOutsidePointer);
        document.addEventListener("keydown", closeOnEscape);
        window.addEventListener("blur", closeOnWindowBlur);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutsidePointer);
            document.removeEventListener("keydown", closeOnEscape);
            window.removeEventListener("blur", closeOnWindowBlur);
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
                        onSignIn={onSignIn}
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
    onSignIn,
}: {
    panelRef: React.RefObject<HTMLDivElement>;
    checks?: CommitChecksValue;
    position: { left: number; top: number; placement: "above" | "below" };
    onOpenCheckUrl: (url: string) => void;
    onSignIn?: (host: string) => void;
}): React.ReactElement {
    const snapshot = checks && checks !== "loading" ? checks : undefined;
    const signInHost =
        snapshot && snapshot.state === "unavailable" ? snapshot.signInHost : undefined;
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
                        {signInHost && onSignIn ? (
                            <button
                                type="button"
                                style={signInButtonStyle}
                                onClick={() => onSignIn(signInHost)}
                            >
                                {t("commit.checks.signIn")}
                            </button>
                        ) : null}
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
        // svg-spinners:tadpole, inlined. Self-animating SMIL (no CSS keyframe),
        // fill="currentColor" so it picks up the pending state color. The icon's
        // built-in 0.75s spin is slowed to 1.3s.
        return (
            <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true" style={style}>
                <path
                    fill="currentColor"
                    d="M12,23a9.63,9.63,0,0,1-8-9.5,9.51,9.51,0,0,1,6.79-9.1A1.66,1.66,0,0,0,12,2.81h0a1.67,1.67,0,0,0-1.94-1.64A11,11,0,0,0,12,23Z"
                >
                    <animateTransform
                        attributeName="transform"
                        type="rotate"
                        dur="1.3s"
                        repeatCount="indefinite"
                        values="0 12 12;360 12 12"
                    />
                </path>
            </svg>
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
    width: "max-content",
    maxWidth: `min(${PANEL_MAX_WIDTH}px, calc(100vw - 16px))`,
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
    background: "var(--vscode-textLink-foreground)",
    color: "var(--vscode-button-foreground)",
};

const bodyStyle: React.CSSProperties = {
    padding: "14px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 11,
    boxSizing: "border-box",
    width: "max-content",
    maxWidth: "100%",
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
    width: "max-content",
    maxWidth: PANEL_TEXT_MAX_WIDTH,
};

const linkButtonStyle: React.CSSProperties = {
    border: "none",
    background: "transparent",
    color: "var(--vscode-textLink-foreground, #4ea1ff)",
    padding: 0,
    textAlign: "left",
    fontSize: 13,
    cursor: "pointer",
    maxWidth: "100%",
    overflowWrap: "anywhere",
};

const nameStyle: React.CSSProperties = {
    color: "var(--vscode-textLink-foreground, #4ea1ff)",
    fontSize: 13,
    maxWidth: "100%",
    overflowWrap: "anywhere",
};

const descriptionStyle: React.CSSProperties = {
    color: JETBRAINS_UI.color.muted,
    fontSize: 12,
    lineHeight: "16px",
    maxWidth: "100%",
    overflowWrap: "anywhere",
};

const emptyStyle: React.CSSProperties = {
    color: JETBRAINS_UI.color.muted,
    fontSize: 12,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 8,
};

const signInButtonStyle: React.CSSProperties = {
    border: "none",
    borderRadius: 4,
    background: "var(--vscode-button-background, #2f6fde)",
    color: "var(--vscode-button-foreground, #ffffff)",
    padding: "4px 12px",
    fontSize: 12,
    cursor: "pointer",
};
