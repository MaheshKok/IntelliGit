// Custom checkbox styled to match VS Code's native checkboxes.
// Replaces Chakra's Checkbox to guarantee white borders on dark backgrounds.

import React, { useRef, useEffect } from "react";

interface Props {
    isChecked: boolean;
    isIndeterminate?: boolean;
    onChange: () => void;
}

const SIZE = 15;
const BORDER_RADIUS = 2;
const UNCHECKED_BG = "transparent";
const UNCHECKED_BORDER = "rgba(221, 226, 237, 0.66)";
const CHECKED_BG = "rgba(90, 128, 197, 0.18)";
const CHECKED_BORDER = "#7ea2dc";
const CHECK_COLOR = "#cfe2ff";

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
                    borderRadius: BORDER_RADIUS,
                    background: filled ? CHECKED_BG : UNCHECKED_BG,
                    pointerEvents: "none",
                    boxShadow: filled ? "inset 0 0 0 1px rgba(160, 189, 237, 0.14)" : "none",
                }}
            >
                {isChecked && !isIndeterminate && (
                    <svg width="10" height="10" viewBox="0 0 12 12">
                        <path
                            d="M10 3.25L4.7 8.45 2.2 6"
                            fill="none"
                            stroke={CHECK_COLOR}
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                )}
                {isIndeterminate && (
                    <span
                        style={{
                            width: 7,
                            height: 2,
                            background: CHECK_COLOR,
                            borderRadius: 1,
                        }}
                    />
                )}
            </span>
        </span>
    );
}

export const VscCheckbox = React.memo(VscCheckboxInner);
