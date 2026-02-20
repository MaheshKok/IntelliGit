import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import type { CommitDetail, ThemeFolderIconMap, ThemeIconFont, ThemeTreeIcon } from "../../types";
import type { CommitInfoOutbound, CommitInfoInbound } from "./commitInfoTypes";
import { getVsCodeApi } from "./shared/vscodeApi";
import theme from "./commit-panel/theme";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { ThemeIconFontFaces } from "./shared/components/ThemeIconFontFaces";

const vscode = getVsCodeApi<CommitInfoOutbound, unknown>();

function App(): React.ReactElement {
    const [detail, setDetail] = useState<CommitDetail | null>(null);
    const [folderIcon, setFolderIcon] = useState<ThemeTreeIcon | undefined>(undefined);
    const [folderExpandedIcon, setFolderExpandedIcon] = useState<ThemeTreeIcon | undefined>(
        undefined,
    );
    const [folderIconsByName, setFolderIconsByName] = useState<ThemeFolderIconMap | undefined>(
        undefined,
    );
    const [iconFonts, setIconFonts] = useState<ThemeIconFont[]>([]);

    useEffect(() => {
        const handler = (event: MessageEvent<CommitInfoInbound>) => {
            const msg = event.data;
            switch (msg.type) {
                case "clear":
                    setDetail(null);
                    setFolderIcon(undefined);
                    setFolderExpandedIcon(undefined);
                    setFolderIconsByName(undefined);
                    setIconFonts([]);
                    return;
                case "setCommitDetail":
                    setDetail(msg.detail);
                    setFolderIcon(msg.folderIcon);
                    setFolderExpandedIcon(msg.folderExpandedIcon);
                    setFolderIconsByName(msg.folderIconsByName);
                    setIconFonts(msg.iconFonts ?? []);
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

    return (
        <>
            <ThemeIconFontFaces fonts={iconFonts} />
            <CommitInfoPane
                detail={detail}
                folderIcon={folderIcon}
                folderExpandedIcon={folderExpandedIcon}
                folderIconsByName={folderIconsByName}
            />
        </>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
