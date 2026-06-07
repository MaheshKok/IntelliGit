import type { ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { getLeafName } from "./path";

/**
 * Resolves the best folder icon for a tree row.
 *
 * Named folder icons are matched by the lower-cased path leaf first, then the
 * expanded/default theme icons are used as fallbacks without mutating the icon maps.
 */
export function resolveFolderIcon(
    nameOrPath: string,
    isExpanded: boolean,
    folderIconsByName?: ThemeFolderIconMap,
    folderIcon?: ThemeTreeIcon,
    folderExpandedIcon?: ThemeTreeIcon,
): ThemeTreeIcon | undefined {
    const leafName = getLeafName(nameOrPath);
    const nameKey = leafName.trim().toLowerCase();
    const namedIcons = nameKey ? folderIconsByName?.[nameKey] : undefined;

    return isExpanded
        ? (namedIcons?.expanded ?? folderExpandedIcon ?? namedIcons?.collapsed ?? folderIcon)
        : (namedIcons?.collapsed ?? folderIcon);
}
