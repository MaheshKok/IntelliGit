// Colored single-letter status indicator (M/A/D/R/U) displayed at the
// end of each file row to show the git working tree status.

import React from "react";
import { Box } from "@chakra-ui/react";
import { GIT_STATUS_COLORS, GIT_STATUS_LABELS, JETBRAINS_UI } from "../tokens";
import { getSettings } from "../settings";
import { t } from "../i18n";

interface Props {
    status: string;
    /**
     * True when the enclosing row paints a selection background. The badge then
     * inherits the row's foreground rather than forcing a status colour chosen for
     * the panel background onto a selection background -- see the note on
     * TreeFileStats in FileTreeRows.tsx for the measurements.
     *
     * The letter itself still carries the status, and `title` still carries the
     * localized label, so nothing is lost but the redundant colour channel, and
     * only on the one row that is selected.
     */
    inheritColor?: boolean;
}

const PYCHARM_STATUS_COLORS: Record<string, string> = {
    M: "var(--intelligit-pycharm-modified)",
    A: "var(--intelligit-pycharm-added)",
    D: "var(--intelligit-pycharm-deleted)",
    R: "var(--vscode-gitDecoration-renamedResourceForeground, #a371f7)",
    U: "var(--vscode-gitDecoration-conflictingResourceForeground, #e5c07b)",
    "?": "var(--intelligit-pycharm-added)",
    "!": "var(--intelligit-pycharm-muted)",
    C: "var(--intelligit-pycharm-added)",
    T: "var(--intelligit-pycharm-modified)",
};
const STATUS_LABEL_KEYS: Record<string, string> = {
    M: "status.modified",
    A: "status.added",
    D: "status.deleted",
    R: "status.renamed",
    U: "status.conflicting",
    "?": "status.unversioned",
    "!": "status.ignored",
    C: "status.copied",
    T: "status.typeChanged",
};

function StatusBadgeInner({ status, inheritColor = false }: Props): React.ReactElement {
    const { iconStyle } = getSettings();
    // `inheritColor` short-circuits BOTH branches, not just the coloured one: the
    // "standard" branch pins `--vscode-foreground`, which is chosen to contrast with
    // the panel background and is no more correct on a selection background than the
    // status colours are.
    const color = inheritColor
        ? undefined
        : iconStyle === "standard"
          ? "var(--vscode-foreground)"
          : (PYCHARM_STATUS_COLORS[status] ??
            GIT_STATUS_COLORS[status] ??
            JETBRAINS_UI.color.muted);
    const labelKey = STATUS_LABEL_KEYS[status];
    const label = labelKey ? t(labelKey) : (GIT_STATUS_LABELS[status] ?? status);
    const letter = status === "?" ? "U" : status === "!" ? "I" : status;

    return (
        <Box
            as="span"
            color={color}
            fontSize="11px"
            fontWeight={600}
            w="12px"
            textAlign="center"
            flexShrink={0}
            title={label}
        >
            {letter}
        </Box>
    );
}

/**
 * Memoized Git status badge for file rows.
 *
 * The badge maps status codes to localized tooltips and PyCharm-colored glyphs,
 * displaying unversioned `?` files as the user-facing `U` marker.
 */
export const StatusBadge = React.memo(StatusBadgeInner);
