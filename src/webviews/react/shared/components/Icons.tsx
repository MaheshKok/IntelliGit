import React from "react";
import { LuGitBranch, LuSearch, LuTag, LuX } from "react-icons/lu";
import type { CSSProperties } from "react";
import { JETBRAINS_UI } from "../tokens";

export const ICON_SIZE = JETBRAINS_UI.size.icon;

export const BASE_ICON_STYLE: CSSProperties = {
    flexShrink: 0,
    marginRight: 4,
    opacity: 0.92,
};

export function SearchIcon({
    size = 16,
    style,
}: {
    size?: number;
    style?: CSSProperties;
}): React.ReactElement {
    return <LuSearch size={size} style={{ flexShrink: 0, ...style }} />;
}

export function ClearIcon({ size = 14 }: { size?: number }): React.ReactElement {
    return <LuX size={size} />;
}

export function GitBranchIcon({
    color = JETBRAINS_UI.color.branch,
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
            data-branch-icon
        >
            <path
                fill={color}
                d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6.5a.5.5 0 0 1-.5.5H9.25a1.75 1.75 0 0 0-1.75 1.75v.872a2.25 2.25 0 1 1-1.5 0V4.372a2.25 2.25 0 1 1 1.5 0v3.256A3.25 3.25 0 0 1 9.25 6.5H12V5.372a2.25 2.25 0 0 1-2.5-2.122zM4.25 3.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5zM4.25 14a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"
            />
        </svg>
    );
}

export function TagIcon({
    color = JETBRAINS_UI.color.tag,
    stretchX = 1,
}: {
    color?: string;
    stretchX?: number;
}): React.ReactElement {
    const iconStyle =
        stretchX === 1
            ? BASE_ICON_STYLE
            : { ...BASE_ICON_STYLE, transform: `scaleX(${stretchX})`, transformOrigin: "center" };
    return (
        <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={iconStyle}
            data-branch-icon
        >
            <path
                fill={color}
                d="M9.28 1.5H5.5A2.5 2.5 0 0 0 3 4v8a2.5 2.5 0 0 0 2.5 2.5h3.78a1.5 1.5 0 0 0 1.06-.44l3.72-3.72a1.5 1.5 0 0 0 0-2.12L10.34 1.94a1.5 1.5 0 0 0-1.06-.44zM5.5 3h3.78l3.72 3.72-3.72 3.72H5.5A1 1 0 0 1 4.5 9.44V4A1 1 0 0 1 5.5 3zm1.25 2a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"
            />
        </svg>
    );
}

export function TagRightIcon({
    color = JETBRAINS_UI.color.currentBranch,
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
            data-branch-icon
        >
            <path
                fill={color}
                d="M1.5 4A2.5 2.5 0 0 1 4 1.5h5.3a1.5 1.5 0 0 1 1.06.44l3.7 3.7a1.5 1.5 0 0 1 0 2.12l-3.7 3.7a1.5 1.5 0 0 1-1.06.44H4A2.5 2.5 0 0 1 1.5 9.4V4zm2.5-1a1 1 0 0 0-1 1v5.4a1 1 0 0 0 1 1h5.3L13 6.7 9.3 3H4zm1.8 1.7a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"
            />
        </svg>
    );
}

export function StarIcon({
    color = "var(--vscode-charts-yellow, #e8c75f)",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
            data-branch-icon
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
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={{
                ...BASE_ICON_STYLE,
                opacity: 0.68,
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 0.1s",
            }}
        >
            <path fill="currentColor" d="M6 4l4 4-4 4z" />
        </svg>
    );
}

export function FolderIcon({
    color = "var(--vscode-symbolIcon-folderForeground, var(--vscode-icon-foreground, currentColor))",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
            data-branch-icon
        >
            <path
                fill={color}
                d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.85A.5.5 0 0 0 6.5 2.5H1.5z"
            />
        </svg>
    );
}

export function FileIcon({
    color = "var(--vscode-symbolIcon-fileForeground, var(--vscode-icon-foreground, currentColor))",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            style={{ color }}
        >
            <path
                fill="currentColor"
                fillRule="evenodd"
                d="M4 1h5.586a1 1 0 0 1 .707.293l2.414 2.414A1 1 0 0 1 13 4.414V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm0 1v12h8V4.414L9.586 2H4zm5 .5V5h2.5z"
            />
        </svg>
    );
}

export function RepoIcon({
    color = "var(--vscode-symbolIcon-folderForeground, var(--vscode-icon-foreground, currentColor))",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={BASE_ICON_STYLE}
            data-branch-icon
        >
            <path
                fill={color}
                d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8zM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2z"
            />
        </svg>
    );
}

export function RefBranchIcon({
    size = 12,
    color = JETBRAINS_UI.color.branch,
}: {
    size?: number;
    color?: string;
}): React.ReactElement {
    return <LuGitBranch size={size} color={color} />;
}

export function RefTagIcon({
    size = 12,
    color = JETBRAINS_UI.color.tag,
}: {
    size?: number;
    color?: string;
}): React.ReactElement {
    return <LuTag size={size} color={color} />;
}
