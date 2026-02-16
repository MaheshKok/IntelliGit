// Renders vertical indent guide lines for tree depth levels.
// Positioned absolutely within file/folder rows.

import React from "react";
import { Box } from "@chakra-ui/react";

const INDENT_STEP = 18;
const INDENT_BASE = 24;
const GUIDE_BASE = 31; // INDENT_BASE(24) + chevron_center(7) = 31
const SECTION_GUIDE = 13; // section header: padding(6) + chevron_center(7) = 13

interface Props {
    treeDepth: number;
}

function IndentGuidesInner({ treeDepth }: Props): React.ReactElement {
    return (
        <>
            <Box
                as="span"
                position="absolute"
                top={0}
                bottom={0}
                w="1px"
                bg="var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.12))"
                left={`${SECTION_GUIDE}px`}
            />
            {Array.from({ length: treeDepth }, (_, i) => (
                <Box
                    key={i}
                    as="span"
                    position="absolute"
                    top={0}
                    bottom={0}
                    w="1px"
                    bg="var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.12))"
                    left={`${GUIDE_BASE + i * INDENT_STEP}px`}
                />
            ))}
        </>
    );
}

export const IndentGuides = React.memo(IndentGuidesInner);

export { INDENT_STEP, INDENT_BASE };
