import type { ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";

export function resolveFolderIcon(
    nameOrPath: string,
    isExpanded: boolean,
    folderIconsByName?: ThemeFolderIconMap,
    folderIcon?: ThemeTreeIcon,
    folderExpandedIcon?: ThemeTreeIcon,
): ThemeTreeIcon | undefined {
    const leafName = nameOrPath.split("/").pop() ?? nameOrPath;
    const nameKey = leafName.trim().toLowerCase();
    const namedIcons = nameKey ? folderIconsByName?.[nameKey] : undefined;

    return isExpanded
        ? (namedIcons?.expanded ?? folderExpandedIcon ?? namedIcons?.collapsed ?? folderIcon)
        : (namedIcons?.collapsed ?? folderIcon);
}
