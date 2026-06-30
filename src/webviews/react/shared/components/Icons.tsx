import React from "react";
import { LuGitBranch, LuSearch, LuTag, LuX } from "react-icons/lu";
import type { CSSProperties } from "react";
import { JETBRAINS_UI } from "../tokens";
import { BASE_ICON_STYLE, ICON_SIZE } from "./iconStyles";

const CHEVRON_ICON_SIZE = 16;

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
            <g fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round">
                <path strokeWidth="1.8" d="M5 4.8v6.4" />
                <path strokeWidth="1.8" d="M5 8h3.35A2.65 2.65 0 0 0 11 5.35V4.8" />
                <circle cx="5" cy="3.1" r="1.55" strokeWidth="1.9" />
                <circle cx="5" cy="12.9" r="1.55" strokeWidth="1.9" />
                <circle cx="11" cy="3.1" r="1.55" strokeWidth="1.9" />
            </g>
        </svg>
    );
}

export function WorktreeSmallIcon({
    color = JETBRAINS_UI.color.branch,
    style,
}: {
    color?: string;
    style?: CSSProperties;
}): React.ReactElement {
    return (
        <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox="0 0 10 10"
            aria-hidden="true"
            focusable="false"
            style={{ ...BASE_ICON_STYLE, color, ...style }}
            data-branch-icon
        >
            <path
                fill="currentColor"
                d="M8.854 7.14578C8.659 6.95078 8.342 6.95078 8.147 7.14578C7.952 7.34079 7.952 7.65778 8.147 7.85279L8.293 7.99879H5.75C5.337 7.99879 5 7.66279 5 7.24879V3.74879C5 3.33479 5.337 2.99879 5.75 2.99879H8.293L8.147 3.14479C7.952 3.33979 7.952 3.65679 8.147 3.85179C8.245 3.94979 8.373 3.99779 8.501 3.99779C8.629 3.99779 8.757 3.94879 8.855 3.85179L9.855 2.85179C10.05 2.65679 10.05 2.33979 9.855 2.14479L8.855 1.14479C8.66 0.949785 8.343 0.949785 8.148 1.14479C7.953 1.33979 7.953 1.65679 8.148 1.85179L8.294 1.99779H5.751C4.786 1.99779 4.001 2.78279 4.001 3.74779V4.99779H0.5C0.224 4.99779 0 5.22179 0 5.49779C0 5.77379 0.224 5.99779 0.5 5.99779H4V7.24779C4 8.21279 4.785 8.99779 5.75 8.99779H8.293L8.147 9.14379C7.952 9.33879 7.952 9.65579 8.147 9.85079C8.245 9.94878 8.373 9.99679 8.501 9.99679C8.629 9.99679 8.757 9.94779 8.855 9.85079L9.855 8.85078C10.05 8.65578 10.05 8.33879 9.855 8.14378L8.855 7.14378L8.854 7.14578Z"
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
                fill="none"
                stroke={color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
                d="M2.25 4.2A2.2 2.2 0 0 1 4.45 2h4.8c.4 0 .78.16 1.06.44l3.35 3.35c.58.58.58 1.52 0 2.1l-3.35 3.35c-.28.28-.66.44-1.06.44h-4.8a2.2 2.2 0 0 1-2.2-2.2V4.2z"
            />
            <circle cx="5.45" cy="6.85" r="1.2" fill="none" stroke={color} strokeWidth="1.7" />
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
            width={CHEVRON_ICON_SIZE}
            height={CHEVRON_ICON_SIZE}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            style={{
                ...BASE_ICON_STYLE,
                marginRight: 2,
                opacity: 0.78,
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transformOrigin: "center",
                transition: "transform 0.1s",
                verticalAlign: "text-bottom",
            }}
        >
            <path
                d="M6 4.5 9.5 8 6 11.5"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
            />
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

export function PushArrowIcon({
    color = "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
                d="M6 10V2.2M2.7 5.2 6 1.9l3.3 3.3"
                fill="none"
                stroke={color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.1"
            />
        </svg>
    );
}

export function PullArrowIcon({
    color = "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)",
}: {
    color?: string;
}): React.ReactElement {
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
                d="M6 2v7.8M2.7 6.8 6 10.1l3.3-3.3"
                fill="none"
                stroke={color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.1"
            />
        </svg>
    );
}

export function ExpandAllIconGlyph(): React.ReactElement {
    return (
        <path
            fill="currentColor"
            fillRule="evenodd"
            d="M5.828 10.172a.5.5 0 0 0-.707 0l-4.096 4.096V11.5a.5.5 0 0 0-1 0v3.975a.5.5 0 0 0 .5.5H4.5a.5.5 0 0 0 0-1H1.732l4.096-4.096a.5.5 0 0 0 0-.707m4.344-4.344a.5.5 0 0 0 .707 0l4.096-4.096V4.5a.5.5 0 1 0 1 0V.525a.5.5 0 0 0-.5-.5H11.5a.5.5 0 0 0 0 1h2.768l-4.096 4.096a.5.5 0 0 0 0 .707"
        />
    );
}

export function CollapseAllIconGlyph(): React.ReactElement {
    return (
        <path
            fill="currentColor"
            fillRule="evenodd"
            d="M.172 15.828a.5.5 0 0 0 .707 0l4.096-4.096V14.5a.5.5 0 1 0 1 0v-3.975a.5.5 0 0 0-.5-.5H1.5a.5.5 0 0 0 0 1h2.768L.172 15.121a.5.5 0 0 0 0 .707M15.828.172a.5.5 0 0 0-.707 0l-4.096 4.096V1.5a.5.5 0 1 0-1 0v3.975a.5.5 0 0 0 .5.5H14.5a.5.5 0 0 0 0-1h-2.768L15.828.879a.5.5 0 0 0 0-.707"
        />
    );
}
