import React from "react";
import type { ShelfEntry } from "../../../protocol/commitPanelMessages";
import type { MenuItem } from "../../shared/components/ContextMenu";
import { t } from "../../shared/i18n";
import type { ShelfContextAction } from "./ShelfRow";

/** Action value reserved for the one visual Shelf menu divider. */
type SeparatorAction = "shelf-menu-separator";
/** Typed menu entry rendered by the shared Shelf context-menu builder. */
export type ShelfMenuItem = Omit<MenuItem, "action"> & {
    action: ShelfContextAction | SeparatorAction;
};

/** Inputs that decide lifecycle, selection, and file-scoped Shelf menu availability. */
export interface ShelfMenuContext {
    shelf: ShelfEntry | null;
    targetChangeId?: string;
    shelfFilesAreCurrent: boolean;
    canUnshelve: boolean;
    canExportPatch: boolean;
    isMac: boolean;
}

function menuIcon(path: React.ReactNode): React.ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            {path}
        </svg>
    );
}

function iconUnshelve(): React.ReactElement {
    return menuIcon(
        <path fill="currentColor" d="M8 1l4 4H9v5H7V5H4l4-4zm-5 9h10v5H3v-5zm1 1v3h8v-3H4z" />,
    );
}

function iconDiff(): React.ReactElement {
    return menuIcon(
        <path
            fill="currentColor"
            d="M2 2h5v5H2V2zm1 1v3h3V3H3zm6-1h5v5H9V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm8 0h1v2h2v1h-2v1h-1v-1H9v-1h2v-1z"
        />,
    );
}

function iconPatch(): React.ReactElement {
    return menuIcon(
        <path
            fill="currentColor"
            d="M3 2h7v1H3v10h7v1H2V2h1zm9 2v3h-1V5H8V4h3V2h1v2zm-4 5h3v-2h1v2h2v1h-2v2h-1v-2H8V9z"
        />,
    );
}

/** Builds the shared PyCharm-parity context menu for shelf rows and shelf-file rows. */
export function getShelfMenuItems({
    shelf,
    shelfFilesAreCurrent,
    canUnshelve,
    canExportPatch,
    isMac,
}: ShelfMenuContext): ShelfMenuItem[] {
    const hasSelection = shelf !== null;
    const isApplied = shelf?.metadata.lifecycle === "applied";
    const unshelveHint = isMac ? "⇧⌘U" : "Ctrl+Shift+U";
    const diffHint = isMac ? "⌘D" : "Ctrl+D";
    const scopedPatchAvailable = hasSelection && shelfFilesAreCurrent && canExportPatch;

    return [
        {
            label: t("shelf.action.unshelveMenu"),
            action: "unshelve",
            icon: iconUnshelve(),
            hint: unshelveHint,
            disabled: !shelfFilesAreCurrent || !canUnshelve || isApplied,
        },
        {
            label: t("shelf.action.unshelveSilently"),
            action: "unshelveSilently",
            disabled: !shelfFilesAreCurrent || !canUnshelve || isApplied,
        },
        {
            label: t("shelf.action.restore"),
            action: "restore",
            disabled: !hasSelection || !isApplied,
        },
        {
            label: t("common.showDiff"),
            action: "showDiff",
            icon: iconDiff(),
            hint: diffHint,
            disabled: !hasSelection,
        },
        {
            label: t("shelf.action.showDiffNewTab"),
            action: "showDiffNewTab",
            icon: iconDiff(),
            disabled: !hasSelection,
        },
        {
            label: t("shelf.action.compareWithLocal"),
            action: "compareWithLocal",
            disabled: !hasSelection,
        },
        {
            label: t("shelf.action.createPatch"),
            action: "createPatch",
            icon: iconPatch(),
            disabled: !scopedPatchAvailable,
        },
        {
            label: t("shelf.action.copyPatchToClipboard"),
            action: "copyPatchToClipboard",
            disabled: !scopedPatchAvailable,
        },
        { label: t("shelf.action.importPatches"), action: "importPatches", disabled: false },
        { label: "", action: "shelf-menu-separator", separator: true },
        {
            label: t("shelf.action.rename"),
            action: "rename",
            hint: "F2",
            disabled: !hasSelection,
        },
        {
            label: t("shelf.action.delete"),
            action: "delete",
            hint: isMac ? "⌫" : "Del",
            disabled: !hasSelection,
        },
    ];
}
