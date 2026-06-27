import React, {
    useRef,
    useEffect,
    useLayoutEffect,
    useState,
    useCallback,
    useInsertionEffect,
    useMemo,
} from "react";
import { createPortal } from "react-dom";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { JETBRAINS_UI } from "../tokens";

const ITEM_HEIGHT = 28;
const ITEM_FONT_SIZE = 13;
const CONTEXT_MENU_STYLE_ID = "intelligit-ctx-styles";
const CONTEXT_MENU_STYLE_RULES = `
    .intelligit-context-item[data-disabled="false"]:hover,
    .intelligit-context-item[data-disabled="false"]:focus-visible {
        background: var(--vscode-menu-selectionBackground, ${JETBRAINS_UI.color.menuSelection});
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
const CONTEXT_MENU_SEPARATOR_STYLE: React.CSSProperties = {
    height: 1,
    margin: "4px 8px",
    background: `var(--vscode-menu-separatorBackground, ${JETBRAINS_UI.color.menuSeparator})`,
};
const CONTEXT_MENU_ICON_STYLE: React.CSSProperties = {
    width: 16,
    height: 16,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    opacity: 0.95,
};
const CONTEXT_MENU_ICON_PLACEHOLDER_STYLE: React.CSSProperties = {
    ...CONTEXT_MENU_ICON_STYLE,
    opacity: 0,
};
const CONTEXT_MENU_LABEL_STYLE: React.CSSProperties = {
    flex: 1,
    flexShrink: 1,
};
const CONTEXT_MENU_TRAILING_STYLE: React.CSSProperties = {
    minWidth: 58,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "flex-end",
    flexShrink: 0,
    overflow: "visible",
    fontSize: 12,
    color: `var(--vscode-descriptionForeground, ${JETBRAINS_UI.color.menuHint})`,
    paddingLeft: 16,
};
const CONTEXT_MENU_DISABLED_TRAILING_STYLE: React.CSSProperties = {
    ...CONTEXT_MENU_TRAILING_STYLE,
    color: `var(--vscode-disabledForeground, ${JETBRAINS_UI.color.menuHint})`,
};

function createContextMenuItemStyle(
    hasAnyIcon: boolean,
    hasAnyTrailing: boolean,
    disabled: boolean,
): React.CSSProperties {
    return {
        display: "flex",
        alignItems: "center",
        gap: hasAnyIcon ? 8 : 0,
        minHeight: ITEM_HEIGHT,
        padding: `0 ${hasAnyTrailing ? 12 : 8}px 0 ${hasAnyIcon ? 12 : 8}px`,
        margin: 0,
        borderRadius: 0,
        cursor: disabled ? "default" : "pointer",
        fontSize: ITEM_FONT_SIZE,
        lineHeight: `${ITEM_HEIGHT}px`,
        color: disabled
            ? "var(--vscode-disabledForeground, rgba(187,191,196,1))"
            : `var(--vscode-menu-foreground, ${JETBRAINS_UI.color.menuForeground})`,
        whiteSpace: "nowrap",
    };
}

/**
 * Menu item contract consumed by shared JetBrains-style context menus.
 *
 * `action` is the stable command identifier returned through `onSelect`, while
 * `label`, `icon`, `hint`, and `submenu` are display-only metadata. Separator rows
 * ignore action handling and are rendered as visual dividers.
 */
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

/**
 * Renders a JetBrains-style floating context menu as a React portal.
 *
 * The menu is positioned at the caller-supplied coordinates and clamped to the
 * viewport so it never renders off-screen. Click-outside, Escape, and window
 * blur all dismiss the menu without propagating to parent handlers.
 *
 * @remarks A `<style>` element with hover/focus-visible rules is injected once
 * per document via `useInsertionEffect` to avoid per-menu style duplication.
 * Item keyboard activation supports Enter and Space.
 */
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
    const menuStyle = useMemo<React.CSSProperties>(
        () => ({
            position: "fixed",
            left: pos.left,
            top: pos.top,
            zIndex: 30,
            background: JETBRAINS_UI.color.panel,
            border: `1px solid var(--vscode-menu-border, ${JETBRAINS_UI.color.menuBorder})`,
            borderRadius: 8,
            padding: "4px 0",
            minWidth,
            fontFamily: SYSTEM_FONT_STACK,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.35)",
        }),
        [minWidth, pos.left, pos.top],
    );
    const enabledItemStyle = useMemo(
        () => createContextMenuItemStyle(hasAnyIcon, hasAnyTrailing, false),
        [hasAnyIcon, hasAnyTrailing],
    );
    const disabledItemStyle = useMemo(
        () => createContextMenuItemStyle(hasAnyIcon, hasAnyTrailing, true),
        [hasAnyIcon, hasAnyTrailing],
    );

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
        <div ref={ref} role="menu" style={menuStyle}>
            {items.map((item, i) => {
                if (item.separator) {
                    return <div key={`sep-${i}`} style={CONTEXT_MENU_SEPARATOR_STYLE} />;
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
                        style={item.disabled ? disabledItemStyle : enabledItemStyle}
                    >
                        {hasAnyIcon && (
                            <span
                                style={
                                    item.icon
                                        ? CONTEXT_MENU_ICON_STYLE
                                        : CONTEXT_MENU_ICON_PLACEHOLDER_STYLE
                                }
                            >
                                {item.icon}
                            </span>
                        )}
                        <span style={CONTEXT_MENU_LABEL_STYLE}>{item.label}</span>
                        {hasAnyTrailing && (
                            <span
                                style={
                                    item.disabled
                                        ? CONTEXT_MENU_DISABLED_TRAILING_STYLE
                                        : CONTEXT_MENU_TRAILING_STYLE
                                }
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
