import React, {
    useRef,
    useEffect,
    useLayoutEffect,
    useState,
    useCallback,
    useInsertionEffect,
} from "react";
import { createPortal } from "react-dom";

const ITEM_HEIGHT = 28;
const ITEM_FONT_SIZE = 13;
const CONTEXT_MENU_STYLE_ID = "intelligit-ctx-styles";
const CONTEXT_MENU_STYLE_RULES = `
    .intelligit-context-item[data-disabled="false"]:hover,
    .intelligit-context-item[data-disabled="false"]:focus-visible {
        background: var(--vscode-menu-selectionBackground, #094771);
        color: var(--vscode-menu-selectionForeground, #fff);
    }
    .intelligit-context-item[data-disabled="false"]:focus-visible {
        outline: 1px solid var(--vscode-focusBorder, #007acc);
        box-shadow:
            0 0 0 1px var(--vscode-focusBorder, #007acc),
            inset 0 0 0 1px rgba(255, 255, 255, 0.08);
        outline-offset: -1px;
    }
`;

export interface MenuItem {
    label: string;
    action: string;
    separator?: boolean;
    icon?: React.ReactNode;
    disabled?: boolean;
    hint?: string;
    submenu?: boolean;
}

interface Props {
    x: number;
    y: number;
    items: MenuItem[];
    minWidth?: number;
    onSelect: (action: string) => void;
    onClose: () => void;
}

export function ContextMenu({
    x,
    y,
    items,
    minWidth = 180,
    onSelect,
    onClose,
}: Props): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });
    const menuBodyPaddingX = 4;
    const hasAnyIcon = items.some((item) => !item.separator && !!item.icon);
    const hasAnyTrailing = items.some((item) => !item.separator && (!!item.hint || !!item.submenu));

    useInsertionEffect(() => {
        if (typeof document === "undefined") return;
        if (document.getElementById(CONTEXT_MENU_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = CONTEXT_MENU_STYLE_ID;
        style.textContent = CONTEXT_MENU_STYLE_RULES;
        document.head.appendChild(style);
    }, []);

    useLayoutEffect(() => {
        if (!ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        const pad = 4;
        let left = x;
        let top = y;
        if (top + rect.height > window.innerHeight - pad) {
            top = Math.max(pad, window.innerHeight - rect.height - pad);
        }
        if (left + rect.width > window.innerWidth - pad) {
            left = Math.max(pad, window.innerWidth - rect.width - pad);
        }
        setPos({ left, top });
    }, [x, y, items.length]);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        const handleBlur = () => onClose();
        document.addEventListener("mousedown", handleClick);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("blur", handleBlur);
        return () => {
            document.removeEventListener("mousedown", handleClick);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("blur", handleBlur);
        };
    }, [onClose]);

    const handleItemClick = useCallback(
        (action: string) => {
            onSelect(action);
            onClose();
        },
        [onSelect, onClose],
    );

    return createPortal(
        <div
            ref={ref}
            role="menu"
            style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                zIndex: 9999,
                background: "var(--vscode-menu-background, #3a4254)",
                border: "1px solid var(--vscode-menu-border, rgba(255,255,255,0.14))",
                borderRadius: 9,
                padding: "4px 0",
                minWidth,
                fontFamily:
                    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
                boxShadow:
                    "0 18px 36px rgba(0,0,0,0.46), 0 3px 9px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)",
            }}
        >
            {items.map((item, i) => {
                if (item.separator) {
                    return (
                        <div
                            key={`sep-${i}`}
                            style={{
                                height: 1,
                                margin: `5px ${menuBodyPaddingX + 2}px`,
                                background:
                                    "var(--vscode-menu-separatorBackground, rgba(255,255,255,0.12))",
                            }}
                        />
                    );
                }
                return (
                    <div
                        key={item.action}
                        className="intelligit-context-item"
                        role="menuitem"
                        data-disabled={item.disabled ? "true" : "false"}
                        aria-disabled={item.disabled}
                        tabIndex={item.disabled ? -1 : 0}
                        onClick={item.disabled ? undefined : () => handleItemClick(item.action)}
                        onKeyDown={
                            item.disabled
                                ? undefined
                                : (e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          handleItemClick(item.action);
                                      }
                                  }
                        }
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: hasAnyIcon ? 8 : 0,
                            minHeight: ITEM_HEIGHT,
                            padding: `4px ${hasAnyTrailing ? 9 : 4}px 4px ${hasAnyIcon ? 8 : 4}px`,
                            margin: `0 ${menuBodyPaddingX}px`,
                            borderRadius: 4,
                            cursor: item.disabled ? "default" : "pointer",
                            fontSize: ITEM_FONT_SIZE,
                            lineHeight: "18px",
                            color: item.disabled
                                ? "var(--vscode-disabledForeground, rgba(255,255,255,0.4))"
                                : "var(--vscode-menu-foreground, #d8dbe2)",
                            whiteSpace: "nowrap",
                            opacity: item.disabled ? 0.72 : 1,
                        }}
                    >
                        {hasAnyIcon && (
                            <span
                                style={{
                                    width: 16,
                                    height: 16,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0,
                                    opacity: item.icon ? 0.95 : 0,
                                }}
                            >
                                {item.icon}
                            </span>
                        )}
                        <span style={{ flex: 1, flexShrink: 1 }}>{item.label}</span>
                        {hasAnyTrailing && (
                            <span
                                style={{
                                    minWidth: 58,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "flex-end",
                                    flexShrink: 0,
                                    overflow: "visible",
                                    fontSize: 11,
                                    opacity: 0.7,
                                    color: item.disabled
                                        ? "var(--vscode-disabledForeground, rgba(255,255,255,0.4))"
                                        : "var(--vscode-descriptionForeground, #9ea4b3)",
                                }}
                            >
                                {item.submenu ? (
                                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                                        <path fill="currentColor" d="M6 4l4 4-4 4z" />
                                    </svg>
                                ) : (
                                    (item.hint ?? "")
                                )}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>,
        document.body,
    );
}
