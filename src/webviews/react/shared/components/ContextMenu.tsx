import React, {
    useRef,
    useEffect,
    useLayoutEffect,
    useState,
    useCallback,
    useInsertionEffect,
} from "react";
import { createPortal } from "react-dom";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";

const ITEM_HEIGHT = 28;
const ITEM_FONT_SIZE = 13;
const CONTEXT_MENU_STYLE_ID = "intelligit-ctx-styles";
/** PyCharm New UI context menu colours, used as fallbacks when VS Code theme vars are unavailable. */
const PYCHARM_MENU_BG = "#2B2D30";
const PYCHARM_MENU_BORDER = "#43454A";
const PYCHARM_MENU_FG = "#BBBFC4";
const PYCHARM_MENU_SEPARATOR = "#3E4042";
const PYCHARM_MENU_HINT = "#6E7074";
const CONTEXT_MENU_STYLE_RULES = `
    .intelligit-context-item[data-disabled="false"]:hover,
    .intelligit-context-item[data-disabled="false"]:focus-visible {
        background: var(--vscode-menu-selectionBackground, #2E436E);
        color: var(--vscode-menu-selectionForeground, #DFE1E5);
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
                background: `var(--vscode-menu-background, ${PYCHARM_MENU_BG})`,
                border: `1px solid var(--vscode-menu-border, ${PYCHARM_MENU_BORDER})`,
                borderRadius: 8,
                padding: "4px 0",
                minWidth,
                fontFamily: SYSTEM_FONT_STACK,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.35)",
            }}
        >
            {items.map((item, i) => {
                if (item.separator) {
                    return (
                        <div
                            key={`sep-${i}`}
                            style={{
                                height: 1,
                                margin: "4px 8px",
                                background: `var(--vscode-menu-separatorBackground, ${PYCHARM_MENU_SEPARATOR})`,
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
                            padding: `0 ${hasAnyTrailing ? 12 : 8}px 0 ${hasAnyIcon ? 12 : 8}px`,
                            margin: 0,
                            borderRadius: 0,
                            cursor: item.disabled ? "default" : "pointer",
                            fontSize: ITEM_FONT_SIZE,
                            lineHeight: `${ITEM_HEIGHT}px`,
                            color: item.disabled
                                ? "var(--vscode-disabledForeground, rgba(187,191,196,1))"
                                : `var(--vscode-menu-foreground, ${PYCHARM_MENU_FG})`,
                            whiteSpace: "nowrap",
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
                                    fontSize: 12,
                                    color: item.disabled
                                        ? `var(--vscode-disabledForeground, ${PYCHARM_MENU_HINT})`
                                        : `var(--vscode-descriptionForeground, ${PYCHARM_MENU_HINT})`,
                                    paddingLeft: 16,
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
