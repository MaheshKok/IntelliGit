import React from "react";
import { Box } from "@chakra-ui/react";
import type { ThemeTreeIcon } from "../../../../types";

interface TreeFileIconProps {
    status?: string;
    icon?: ThemeTreeIcon;
}

interface TreeFolderIconProps {
    isExpanded?: boolean;
    icon?: ThemeTreeIcon;
}

function ThemeGlyphIcon({
    icon,
    colorFallback,
    dataTreeIcon,
}: {
    icon: ThemeTreeIcon;
    colorFallback: string;
    dataTreeIcon: "file" | "folder";
}): React.ReactElement | null {
    if (!icon.glyph) return null;
    return (
        <Box
            as="span"
            w="14px"
            h="14px"
            flexShrink={0}
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            lineHeight="14px"
            fontSize={icon.fontSize ?? "14px"}
            fontFamily={icon.fontFamily}
            fontWeight={icon.fontWeight}
            fontStyle={icon.fontStyle}
            color={icon.color ?? colorFallback}
            data-tree-icon={dataTreeIcon}
        >
            {icon.glyph}
        </Box>
    );
}

export function TreeFileIcon({ status, icon }: TreeFileIconProps): React.ReactElement {
    const color =
        status === "D"
            ? "var(--vscode-disabledForeground)"
            : "var(--vscode-symbolIcon-fileForeground, var(--vscode-icon-foreground, currentColor))";

    if (icon?.uri) {
        return (
            <Box
                as="img"
                src={icon.uri}
                w="14px"
                h="14px"
                flexShrink={0}
                objectFit="contain"
                opacity={status === "D" ? 0.6 : undefined}
                filter={status === "D" ? "grayscale(100%)" : undefined}
                data-tree-icon="file"
                alt=""
            />
        );
    }

    if (icon?.glyph) {
        return <ThemeGlyphIcon icon={icon} colorFallback={color} dataTreeIcon="file" />;
    }

    return (
        <Box
            as="span"
            w="14px"
            h="14px"
            flexShrink={0}
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            color={color}
            data-tree-icon="file"
        >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                    fill="currentColor"
                    fillRule="evenodd"
                    d="M4 1h5.586a1 1 0 0 1 .707.293l2.414 2.414A1 1 0 0 1 13 4.414V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm0 1v12h8V4.414L9.586 2H4zm5 .5V5h2.5z"
                />
            </svg>
        </Box>
    );
}

export function TreeFolderIcon({ isExpanded, icon }: TreeFolderIconProps): React.ReactElement {
    if (icon?.uri) {
        return (
            <Box
                as="img"
                src={icon.uri}
                w="14px"
                h="14px"
                flexShrink={0}
                objectFit="contain"
                data-tree-icon="folder"
                alt=""
            />
        );
    }

    const color = isExpanded
        ? "var(--vscode-symbolIcon-folderOpenedForeground, var(--vscode-symbolIcon-folderForeground, var(--vscode-icon-foreground, currentColor)))"
        : "var(--vscode-symbolIcon-folderForeground, var(--vscode-icon-foreground, currentColor))";

    if (icon?.glyph) {
        return <ThemeGlyphIcon icon={icon} colorFallback={color} dataTreeIcon="folder" />;
    }

    return (
        <Box
            as="span"
            w="14px"
            h="14px"
            flexShrink={0}
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            color={color}
            data-tree-icon="folder"
        >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                    fill="currentColor"
                    d="M14.5 4H7.71l-.85-.85A.5.5 0 0 0 6.5 3H1.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V4.5a.5.5 0 0 0-.5-.5z"
                />
            </svg>
        </Box>
    );
}
