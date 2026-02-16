import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
    label: string;
    action: string;
    separator?: boolean;
    icon?: React.ReactNode;
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
            style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                zIndex: 9999,
                background: "var(--vscode-menu-background, #252526)",
                border: "1px solid var(--vscode-menu-border, #454545)",
                borderRadius: 5,
                padding: "4px 0",
                minWidth,
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
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
                                background: "var(--vscode-menu-separatorBackground, #454545)",
                            }}
                        />
                    );
                }
                return (
                    <div
                        key={item.action}
                        onClick={() => handleItemClick(item.action)}
                        onMouseEnter={(e) => {
                            (e.currentTarget as HTMLDivElement).style.background =
                                "var(--vscode-menu-selectionBackground, #094771)";
                            (e.currentTarget as HTMLDivElement).style.color =
                                "var(--vscode-menu-selectionForeground, #fff)";
                        }}
                        onMouseLeave={(e) => {
                            (e.currentTarget as HTMLDivElement).style.background = "";
                            (e.currentTarget as HTMLDivElement).style.color = "";
                        }}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "4px 20px 4px 10px",
                            cursor: "pointer",
                            fontSize: 12,
                            color: "var(--vscode-menu-foreground, #ccc)",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {item.icon && <span style={{ width: 14, height: 14 }}>{item.icon}</span>}
                        {item.label}
                    </div>
                );
            })}
        </div>,
        document.body,
    );
}
