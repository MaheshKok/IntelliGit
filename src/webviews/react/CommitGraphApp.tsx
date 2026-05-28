// React app for the bottom-panel commit graph webview.
// Layout: [BranchColumn (resizable)] | [CommitList] | [CommitInfoPane].

import React from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import type { CommitGraphOutbound } from "./commitGraphTypes";
import { getVsCodeApi } from "./shared/vscodeApi";
import theme from "./commit-panel/theme";
import { CommitGraphPanel } from "./CommitGraphPanel";

const vscode = getVsCodeApi<CommitGraphOutbound, Record<string, unknown>>();

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <CommitGraphPanel vscode={vscode} />
    </ChakraProvider>,
);
