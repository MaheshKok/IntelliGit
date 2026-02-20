import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import type { CommitDetail } from "../../types";
import type { CommitInfoOutbound, CommitInfoInbound } from "./commitInfoTypes";
import { getVsCodeApi } from "./shared/vscodeApi";
import theme from "./commit-panel/theme";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";

const vscode = getVsCodeApi<CommitInfoOutbound, unknown>();

function App(): React.ReactElement {
    const [detail, setDetail] = useState<CommitDetail | null>(null);

    useEffect(() => {
        const handler = (event: MessageEvent<CommitInfoInbound>) => {
            const msg = event.data;
            switch (msg.type) {
                case "clear":
                    setDetail(null);
                    return;
                case "setCommitDetail":
                    setDetail(msg.detail);
                    return;
                default: {
                    const exhaustive: never = msg;
                    void exhaustive;
                    return;
                }
            }
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, []);

    return <CommitInfoPane detail={detail} />;
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
