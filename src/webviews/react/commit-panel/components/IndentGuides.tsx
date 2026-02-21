// Renders vertical indent guide lines for tree depth levels.
// Positioned absolutely within file/folder rows.

import React from "react";
import { Box } from "@chakra-ui/react";

const INDENT_STEP = 16;
const INDENT_BASE = 20;
const GUIDE_BASE = 26; // INDENT_BASE(20) + chevron_center(6) = 26
const SECTION_GUIDE = 11; // section header: padding(5) + chevron_center(6) = 11
const INDENT_GUIDE_COLOR =
    "var(--vscode-editorIndentGuide-background1, var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.2)))";

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
                bg={INDENT_GUIDE_COLOR}
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
                    bg={INDENT_GUIDE_COLOR}
                    left={`${GUIDE_BASE + i * INDENT_STEP}px`}
                />
            ))}
        </>
    );
}

export const IndentGuides = React.memo(IndentGuidesInner);

export { INDENT_STEP, INDENT_BASE };
