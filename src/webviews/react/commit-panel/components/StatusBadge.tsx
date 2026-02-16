// Colored single-letter status indicator (M/A/D/R/U) displayed at the
// end of each file row to show the git working tree status.

import React from "react";
import { Box } from "@chakra-ui/react";

const STATUS_COLORS: Record<string, string> = {
    M: "#d19a66",
    A: "#73c991",
    D: "#c74e39",
    R: "#a371f7",
    U: "#e5c07b",
    "?": "#73c991",
    C: "#73c991",
};

const STATUS_LABELS: Record<string, string> = {
    M: "Modified",
    A: "Added",
    D: "Deleted",
    R: "Renamed",
    U: "Conflicting",
    "?": "Unversioned",
    C: "Copied",
};

interface Props {
    status: string;
}

function StatusBadgeInner({ status }: Props): React.ReactElement {
    const color = STATUS_COLORS[status] ?? "#888";
    const label = STATUS_LABELS[status] ?? status;
    const letter = status === "?" ? "U" : status;

    return (
        <Box
            as="span"
            color={color}
            fontSize="11px"
            fontWeight={600}
            w="14px"
            textAlign="center"
            flexShrink={0}
            title={label}
        >
            {letter}
        </Box>
    );
}

export const StatusBadge = React.memo(StatusBadgeInner);
