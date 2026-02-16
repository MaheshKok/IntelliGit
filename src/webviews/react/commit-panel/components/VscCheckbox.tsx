// Custom checkbox styled to match VS Code's native checkboxes.
// Replaces Chakra's Checkbox to guarantee white borders on dark backgrounds.

import React, { useRef, useEffect } from "react";

interface Props {
    isChecked: boolean;
    isIndeterminate?: boolean;
    onChange: () => void;
}

const SIZE = 16;
const CHECKED_BG = "var(--vscode-checkbox-background, #4a6edb)";
const CHECKED_BORDER = "var(--vscode-checkbox-border, #4a6edb)";
const UNCHECKED_BORDER = "rgba(255, 255, 255, 0.6)";

function VscCheckboxInner({ isChecked, isIndeterminate, onChange }: Props): React.ReactElement {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.indeterminate = !!isIndeterminate;
        }
    }, [isIndeterminate]);

    const filled = isChecked || isIndeterminate;

    return (
        <span
            style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: SIZE,
                height: SIZE,
                flexShrink: 0,
            }}
        >
            <input
                ref={inputRef}
                type="checkbox"
                checked={isChecked}
                onChange={(e) => {
                    e.stopPropagation();
                    onChange();
                }}
                style={{
                    position: "absolute",
                    width: "100%",
                    height: "100%",
                    opacity: 0,
                    cursor: "pointer",
                    margin: 0,
                }}
            />
            <span
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: SIZE,
                    height: SIZE,
                    border: `1px solid ${filled ? CHECKED_BORDER : UNCHECKED_BORDER}`,
                    borderRadius: 3,
                    background: filled ? CHECKED_BG : "transparent",
                    pointerEvents: "none",
                }}
            >
                {isChecked && !isIndeterminate && (
                    <svg width="12" height="12" viewBox="0 0 12 12">
                        <path
                            d="M10 3L4.5 8.5 2 6"
                            fill="none"
                            stroke="white"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                )}
                {isIndeterminate && (
                    <span
                        style={{
                            width: 8,
                            height: 2,
                            background: "white",
                            borderRadius: 1,
                        }}
                    />
                )}
            </span>
        </span>
    );
}

export const VscCheckbox = React.memo(VscCheckboxInner);
