import React from "react";
import { ClearIcon, SearchIcon } from "../../shared/components/Icons";
import { SEARCH_CLEAR_BUTTON_STYLE, SEARCH_CONTAINER_STYLE, SEARCH_INPUT_STYLE } from "../styles";

export interface Props {
    value: string;
    onChange: (value: string) => void;
    onClear: () => void;
}

export function BranchSearchBar({ value, onChange, onClear }: Props): React.ReactElement {
    return (
        <div style={SEARCH_CONTAINER_STYLE}>
            <SearchIcon size={16} style={{ opacity: 0.95 }} />
            <input
                className="branch-search-input"
                type="text"
                aria-label="Search branches"
                placeholder="Search branches"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                style={SEARCH_INPUT_STYLE}
            />
            {value.length > 0 && (
                <button
                    type="button"
                    aria-label="Clear branch search"
                    title="Clear"
                    onClick={onClear}
                    style={SEARCH_CLEAR_BUTTON_STYLE}
                >
                    <ClearIcon size={14} />
                </button>
            )}
        </div>
    );
}
