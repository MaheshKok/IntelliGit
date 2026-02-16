// Colored file extension badge (TS, JS, PY, etc.) shown next to file names.
// Maps file extensions to background colors and abbreviated labels.

import React from "react";
import { Box } from "@chakra-ui/react";
import { FILE_TYPE_BADGES } from "../../shared/tokens";

interface Props {
    filename: string;
    status?: string;
}

function FileTypeIconInner({ filename, status }: Props): React.ReactElement {
    let ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (filename.startsWith(".")) ext = filename.slice(1);

    const info = FILE_TYPE_BADGES[ext] ?? { label: ext.slice(0, 2).toUpperCase(), bg: "#6b6b6b" };
    const bg = status === "D" ? "#6b6b6b" : info.bg;
    const fg = info.fg ?? "#fff";

    return (
        <Box
            as="span"
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            w="16px"
            h="16px"
            flexShrink={0}
            fontSize="7px"
            fontWeight={700}
            borderRadius="2px"
            fontFamily="monospace"
            letterSpacing="-0.5px"
            bg={bg}
            color={fg}
            title={`${ext.toUpperCase()} file`}
        >
            {info.label}
        </Box>
    );
}

export const FileTypeIcon = React.memo(FileTypeIconInner);
