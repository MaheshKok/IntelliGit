// Colored single-letter status indicator (M/A/D/R/U) displayed at the
// end of each file row to show the git working tree status.

import React from "react";
import { Box } from "@chakra-ui/react";
import { GIT_STATUS_COLORS, GIT_STATUS_LABELS } from "../../shared/tokens";
import { getSettings } from "../../shared/settings";
import { t } from "../../shared/i18n";

interface Props {
    status: string;
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

function StatusBadgeInner({ status }: Props): React.ReactElement {
    const { iconStyle } = getSettings();
    const color =
        iconStyle === "standard"
            ? "var(--vscode-foreground)"
            : (PYCHARM_STATUS_COLORS[status] ?? GIT_STATUS_COLORS[status] ?? "#888");
    const labelKey = STATUS_LABEL_KEYS[status];
    const label = labelKey ? t(labelKey) : (GIT_STATUS_LABELS[status] ?? status);
    const letter = status === "?" ? "U" : status === "!" ? "I" : status;

    return (
        <Box
            as="span"
            color={color}
            fontSize="10px"
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
 * Memoized Git status badge for commit-panel file rows.
 *
 * The badge maps status codes to localized tooltips and PyCharm-colored glyphs,
 * displaying unversioned `?` files as the user-facing `U` marker.
 */
export const StatusBadge = React.memo(StatusBadgeInner);
