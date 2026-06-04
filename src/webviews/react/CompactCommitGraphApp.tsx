// Entry point for the sidebar Graph webview. This intentionally uses the
// compact graph body that used to live inside the commit panel, not the
// full branch-column graph layout.

import React from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import type { CommitGraphOutbound } from "../protocol/commitGraphTypes";
import { getVsCodeApi } from "./shared/vscodeApi";
import theme from "./commit-panel/theme";
import { NativeCommitGraph } from "./NativeCommitGraph";

const vscode = getVsCodeApi<CommitGraphOutbound, Record<string, unknown>>();

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <NativeCommitGraph vscode={vscode} />
    </ChakraProvider>,
);
