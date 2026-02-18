// Colored single-letter status indicator (M/A/D/R/U) displayed at the
// end of each file row to show the git working tree status.

import React from "react";
import { Box } from "@chakra-ui/react";
import { GIT_STATUS_COLORS, GIT_STATUS_LABELS } from "../../shared/tokens";

interface Props {
    status: string;
}

function StatusBadgeInner({ status }: Props): React.ReactElement {
    const color = GIT_STATUS_COLORS[status] ?? "#888";
    const label = GIT_STATUS_LABELS[status] ?? status;
    const letter = status === "?" ? "U" : status;

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

export const StatusBadge = React.memo(StatusBadgeInner);
