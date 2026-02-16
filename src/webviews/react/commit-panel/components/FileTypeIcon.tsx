// Colored file extension badge (TS, JS, PY, etc.) shown next to file names.
// Maps file extensions to background colors and abbreviated labels.

import React from "react";
import { Box } from "@chakra-ui/react";

const EXT_ICONS: Record<string, { label: string; bg: string; fg?: string }> = {
    ts: { label: "TS", bg: "#3178c6" },
    tsx: { label: "TX", bg: "#3178c6" },
    js: { label: "JS", bg: "#f0db4f", fg: "#323330" },
    jsx: { label: "JX", bg: "#f0db4f", fg: "#323330" },
    json: { label: "JS", bg: "#5b5b5b" },
    md: { label: "M", bg: "#519aba" },
    css: { label: "CS", bg: "#563d7c" },
    scss: { label: "SC", bg: "#c6538c" },
    html: { label: "HT", bg: "#e44d26" },
    svg: { label: "SV", bg: "#ffb13b", fg: "#323330" },
    py: { label: "PY", bg: "#3572a5" },
    rs: { label: "RS", bg: "#dea584" },
    go: { label: "GO", bg: "#00add8" },
    yaml: { label: "YA", bg: "#cb171e" },
    yml: { label: "YA", bg: "#cb171e" },
    xml: { label: "XM", bg: "#f26522" },
    sh: { label: "SH", bg: "#4eaa25" },
    toml: { label: "TO", bg: "#9c4221" },
    lock: { label: "LK", bg: "#666" },
    gitignore: { label: "GI", bg: "#f34f29" },
    env: { label: "EN", bg: "#ecd53f", fg: "#323330" },
};

interface Props {
    filename: string;
    status?: string;
}

function FileTypeIconInner({ filename, status }: Props): React.ReactElement {
    let ext = filename.split(".").pop()?.toLowerCase() ?? "";
    if (filename.startsWith(".")) ext = filename.slice(1);

    const info = EXT_ICONS[ext] ?? { label: ext.slice(0, 2).toUpperCase(), bg: "#6b6b6b" };
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
