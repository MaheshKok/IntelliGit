import React from "react";
import { Box } from "@chakra-ui/react";
import type { ThemeTreeIcon } from "../../../../types";
import { FileIcon, FolderIcon, ICON_SIZE } from "./Icons";

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
            w={`${ICON_SIZE}px`}
            h={`${ICON_SIZE}px`}
            flexShrink={0}
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            lineHeight={`${ICON_SIZE}px`}
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
                w={`${ICON_SIZE}px`}
                h={`${ICON_SIZE}px`}
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
            w={`${ICON_SIZE}px`}
            h={`${ICON_SIZE}px`}
            flexShrink={0}
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            color={color}
            data-tree-icon="file"
        >
            <FileIcon color={color} />
        </Box>
    );
}

export function TreeFolderIcon({ isExpanded, icon }: TreeFolderIconProps): React.ReactElement {
    if (icon?.uri) {
        return (
            <Box
                as="img"
                src={icon.uri}
                w={`${ICON_SIZE}px`}
                h={`${ICON_SIZE}px`}
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
            <FolderIcon color={color} />
        </Box>
    );
}
