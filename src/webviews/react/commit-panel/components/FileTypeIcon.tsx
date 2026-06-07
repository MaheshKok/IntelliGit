// VS Code-style file icon used in commit panel trees.

import React from "react";
import type { ThemeTreeIcon } from "../../../../types";
import { TreeFileIcon } from "./TreeIcons";

interface Props {
    status?: string;
    icon?: ThemeTreeIcon;
}

function FileTypeIconInner({ status, icon }: Props): React.ReactElement {
    return <TreeFileIcon status={status} icon={icon} />;
}

/**
 * Memoized bridge from commit-panel file rows to the shared theme-aware file icon.
 */
export const FileTypeIcon = React.memo(FileTypeIconInner);
