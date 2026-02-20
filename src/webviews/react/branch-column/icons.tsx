import React from "react";
import { BASE_ICON_STYLE, getChevronIconStyle, NODE_ICON_SIZE } from "./styles";

export function GitBranchIcon({
    color = "var(--vscode-icon-foreground, currentColor)",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={NODE_ICON_SIZE}
            height={NODE_ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
        >
            <path
                fill={color}
                d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6.5a.5.5 0 0 1-.5.5H9.25a1.75 1.75 0 0 0-1.75 1.75v.872a2.25 2.25 0 1 1-1.5 0V4.372a2.25 2.25 0 1 1 1.5 0v3.256A3.25 3.25 0 0 1 9.25 6.5H12V5.372a2.25 2.25 0 0 1-2.5-2.122zM4.25 3.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5zM4.25 14a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"
            />
        </svg>
    );
}

export function TagIcon({
    color = "var(--vscode-icon-foreground, currentColor)",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={NODE_ICON_SIZE}
            height={NODE_ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
        >
            <path
                fill={color}
                d="M9.28 1.5H5.5A2.5 2.5 0 0 0 3 4v8a2.5 2.5 0 0 0 2.5 2.5h3.78a1.5 1.5 0 0 0 1.06-.44l3.72-3.72a1.5 1.5 0 0 0 0-2.12L10.34 1.94a1.5 1.5 0 0 0-1.06-.44zM5.5 3h3.78l3.72 3.72-3.72 3.72H5.5A1 1 0 0 1 4.5 9.44V4A1 1 0 0 1 5.5 3zm1.25 2a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"
            />
        </svg>
    );
}

export function StarIcon({
    color = "var(--vscode-icon-foreground, currentColor)",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={NODE_ICON_SIZE}
            height={NODE_ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
        >
            <path
                fill={color}
                d="M8 1.5l1.8 3.64 4.02.58-2.91 2.83.69 4-3.6-1.9-3.6 1.9.69-4L2.18 5.72l4.02-.58L8 1.5z"
            />
        </svg>
    );
}

export function ChevronIcon({ expanded }: { expanded: boolean }): React.ReactElement {
    return (
        <svg
            width={NODE_ICON_SIZE}
            height={NODE_ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={getChevronIconStyle(expanded)}
        >
            <path fill="currentColor" d="M6 4l4 4-4 4z" />
        </svg>
    );
}

export function FolderIcon({
    color = "var(--vscode-icon-foreground, currentColor)",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={NODE_ICON_SIZE}
            height={NODE_ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
        >
            <path
                fill={color}
                d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.85A.5.5 0 0 0 6.5 2.5H1.5z"
            />
        </svg>
    );
}

export function RepoIcon({
    color = "var(--vscode-icon-foreground, currentColor)",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={NODE_ICON_SIZE}
            height={NODE_ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
        >
            <path
                fill={color}
                d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8zM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2z"
            />
        </svg>
    );
}
