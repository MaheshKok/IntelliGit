// Entry point for the commit panel React webview. Wraps the app in
// ChakraProvider with the VS Code theme and composes all panels.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import theme from "./theme";
import { RepositoryAccordion } from "./components/RepositoryAccordion";
import { useExtensionMessages } from "./hooks/useExtensionMessages";
import { getVsCodeApi } from "./hooks/useVsCodeApi";
import { ThemeIconFontFaces } from "../shared/components/ThemeIconFontFaces";

/**
 * Root commit-panel React app wired to the VS Code webview host.
 *
 * This component owns panel-level message sending for commit, push, publish,
 * amend-message loading, draft persistence, and the local group-by-directory
 * preference shared by the commit and stash tabs.
 */
// Webview entrypoint owns root render side effects; Fast Refresh component-export rule is not applicable here.
// react-doctor-disable-next-line react-doctor/only-export-components
function App(): React.ReactElement {
    const [state, dispatch] = useExtensionMessages();
    const vscode = getVsCodeApi();
    const [groupByDir, setGroupByDir] = useState<boolean>(() => {
        const saved = vscode.getState?.();
        return typeof saved?.groupByDir === "boolean" ? saved.groupByDir : true;
    });
    const iconFonts = useMemo(
        () => state.repositories.flatMap((repository) => repository.iconFonts),
        [state.repositories],
    );

    useEffect(() => {
        const prev = vscode.getState?.() ?? {};
        vscode.setState({ ...prev, groupByDir });
    }, [groupByDir, vscode]);

    const handleToggleExpanded = useCallback(
        (root: string) => {
            const nextRoots = state.expandedRepositoryRoots.includes(root)
                ? state.expandedRepositoryRoots.filter((repositoryRoot) => repositoryRoot !== root)
                : [...state.expandedRepositoryRoots, root];
            dispatch({ type: "SET_EXPANDED_REPOSITORIES", repositoryRoots: nextRoots });
            vscode.postMessage({ type: "setExpandedRepositories", repositoryRoots: nextRoots });
        },
        [dispatch, state.expandedRepositoryRoots, vscode],
    );

    return (
        <Box
            display="flex"
            flexDirection="column"
            h="100%"
            overflow="hidden"
            bg="var(--intelligit-pycharm-panel)"
        >
            <ThemeIconFontFaces fonts={iconFonts} />
            <Box flex={1} minH={0} overflowY="auto" display="flex" flexDirection="column">
                {state.repositories.map((repository) => (
                    <RepositoryAccordion
                        key={repository.root}
                        repository={repository}
                        isExpanded={state.expandedRepositoryRoots.includes(repository.root)}
                        isOnlyRepository={state.repositories.length === 1}
                        groupByDir={groupByDir}
                        onToggleExpanded={handleToggleExpanded}
                        onToggleGroupBy={() => setGroupByDir((value) => !value)}
                        dispatch={dispatch}
                    />
                ))}
            </Box>
        </Box>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
