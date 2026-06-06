// Renders vertical indent guide lines for tree depth levels.
// Positioned absolutely within file/folder rows.

import React from "react";
import { Box } from "@chakra-ui/react";

/** Horizontal distance between nested commit-panel tree levels. */
const INDENT_STEP = 18; // must equal ChevronIcon width (16) + marginRight (2)
/** Left padding used before the first file or folder row glyph. */
const INDENT_BASE = 20;
const GUIDE_BASE = 28; // INDENT_BASE(20) + chevron_half(8) = 28
const SECTION_GUIDE = 17; // section header mx(4) + px(5) + chevron_half(8) = 17
const INDENT_GUIDE_COLOR =
    "var(--vscode-editorIndentGuide-background1, var(--vscode-tree-indentGuidesStroke, rgba(160, 168, 184, 0.28)))";

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

/**
 * Memoized vertical guide renderer for commit-panel file and folder rows.
 *
 * Guides are absolutely positioned from the same indent constants used by rows,
 * keeping section and nested-directory lines aligned while the tree scrolls.
 */
export const IndentGuides = React.memo(IndentGuidesInner);

export { INDENT_STEP, INDENT_BASE };
