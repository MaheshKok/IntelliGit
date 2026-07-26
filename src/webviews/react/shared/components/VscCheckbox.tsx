// Custom checkbox styled to match VS Code's native checkboxes.
// Replaces Chakra's Checkbox to guarantee white borders on dark backgrounds.

import React, { useRef, useEffect } from "react";

interface Props {
    isChecked: boolean;
    isIndeterminate?: boolean;
    onChange: () => void;
    inputTestId?: string;
    inputId?: string;
    ariaLabel?: string;
}

const SIZE = 14;
const BORDER_RADIUS = 2;
const BORDER_WIDTH = 1.5;
const UNCHECKED_BG = "transparent";
const UNCHECKED_BORDER = "var(--intelligit-pycharm-checkbox-unchecked-border)";
const CHECKED_BG = "var(--intelligit-pycharm-checkbox-checked-bg)";
const CHECKED_BORDER = "var(--intelligit-pycharm-blue)";
const CHECK_COLOR = "#c8ddff";
const CHECKBOX_CONTAINER_STYLE: React.CSSProperties = {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: SIZE,
    height: SIZE,
    flexShrink: 0,
};
const CHECKBOX_INPUT_STYLE: React.CSSProperties = {
    position: "absolute",
    width: "100%",
    height: "100%",
    opacity: 0,
    cursor: "pointer",
    margin: 0,
};
const CHECKBOX_UNCHECKED_STYLE: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: SIZE,
    height: SIZE,
    border: `${BORDER_WIDTH}px solid ${UNCHECKED_BORDER}`,
    borderRadius: BORDER_RADIUS,
    background: UNCHECKED_BG,
    pointerEvents: "none",
    boxShadow: "none",
};
const CHECKBOX_FILLED_STYLE: React.CSSProperties = {
    ...CHECKBOX_UNCHECKED_STYLE,
    border: `${BORDER_WIDTH}px solid ${CHECKED_BORDER}`,
    background: CHECKED_BG,
    boxShadow: "inset 0 0 0 1px rgba(160, 189, 237, 0.14)",
};
const INDETERMINATE_MARK_STYLE: React.CSSProperties = {
    width: 6,
    height: 2,
    background: CHECK_COLOR,
    borderRadius: 1,
};

function VscCheckboxInner({
    isChecked,
    isIndeterminate,
    onChange,
    inputTestId,
    inputId,
    ariaLabel,
}: Props): React.ReactElement {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.indeterminate = !!isIndeterminate;
        }
    }, [isIndeterminate]);

    const filled = isChecked || isIndeterminate;

    return (
        <span style={CHECKBOX_CONTAINER_STYLE}>
            <input
                ref={inputRef}
                type="checkbox"
                id={inputId}
                aria-label={ariaLabel}
                data-testid={inputTestId}
                checked={isChecked}
                onChange={(e) => {
                    e.stopPropagation();
                    onChange();
                }}
                style={CHECKBOX_INPUT_STYLE}
            />
            <span style={filled ? CHECKBOX_FILLED_STYLE : CHECKBOX_UNCHECKED_STYLE}>
                {isChecked && !isIndeterminate && (
                    <svg width="9" height="9" viewBox="0 0 12 12">
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
                {isIndeterminate && <span style={INDETERMINATE_MARK_STYLE} />}
            </span>
        </span>
    );
}

/**
 * Memoized VS Code-styled checkbox used by file, folder, section, and amend rows.
 *
 * The native input remains the event source while the visual shell mirrors the
 * checked or indeterminate state for consistent dark-theme borders.
 */
export const VscCheckbox = React.memo(VscCheckboxInner);
