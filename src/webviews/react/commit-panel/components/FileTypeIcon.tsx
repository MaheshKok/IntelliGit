// VS Code-style file icon used in commit panel trees.

import React from "react";
import type { ThemeTreeIcon } from "../../../../types";
import { TreeFileIcon } from "./TreeIcons";

interface Props {
    filename: string;
    status?: string;
    icon?: ThemeTreeIcon;
}

function FileTypeIconInner({ filename: _filename, status, icon }: Props): React.ReactElement {
    return <TreeFileIcon status={status} icon={icon} />;
}

export const FileTypeIcon = React.memo(FileTypeIconInner);
