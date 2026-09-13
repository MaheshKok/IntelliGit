import { FileHistoryPanel } from "../../../src/views/FileHistoryPanel";
import {
    getE2eWebviewCaptureSink,
    resetE2eWebviewCaptureSinkForTests,
} from "../../../src/e2e/webviewCapture";
import type { ScenarioWorkspace } from "../../fixtures/repo/scenarios";
import { createFakeExtensionUri } from "./commitInfoVscodeDouble";
import { getCreatedWebviewPanels, resetCreatedWebviewPanelsForTests } from "./webviewPanelDouble";
import { canonicalizeCapturedMessages } from "./canonicalizeCapturedMessages";
import { buildWebviewFixture } from "./webviewFixtureFile";
import type { WebviewFixture } from "./webviewFixtureTypes";
import type { HistoryInbound } from "../../../src/webviews/protocol/fileHistory";

/** Records the real history host against the seeded repository through the VS Code panel double. */
export async function recordFileHistoryWebviewFixture(
    workspace: ScenarioWorkspace,
): Promise<WebviewFixture> {
    resetCreatedWebviewPanelsForTests();
    resetE2eWebviewCaptureSinkForTests();
    try {
        await FileHistoryPanel.open({
            extensionUri: createFakeExtensionUri(),
            repoRoot: workspace.root,
            filePath: "README.md",
        });
        const panel = getCreatedWebviewPanels()[0];
        if (!panel) throw new Error("History did not create its panel.");
        await panel.receiveMessage({ type: "historyReady" });
        const sink = getE2eWebviewCaptureSink();
        if (!sink) throw new Error("History capture is inactive.");
        const snapshot = sink.getMessages().find((message) => message.contextId === "file-history")
            ?.message as HistoryInbound | undefined;
        if (snapshot?.type !== "historyState" || !snapshot.state.entries.length) {
            throw new Error(`History did not load seeded revisions: ${JSON.stringify(snapshot)}`);
        }
        await panel.receiveMessage({
            type: "historySelect",
            hashes: [snapshot.state.entries[0].hash],
            requestId: 1,
        });
        const preview = sink.getMessages().at(-1)?.message as HistoryInbound | undefined;
        if (preview?.type !== "historyDiff" || !preview.data)
            throw new Error("History fixture preview failed.");
        return buildWebviewFixture(
            "file-history",
            "clean",
            canonicalizeCapturedMessages(
                sink.getMessages().filter((message) => message.contextId === "file-history"),
                {
                    root: workspace.root,
                    originRoot: workspace.template?.originRoot ?? "",
                    profileDir: "",
                },
                [],
            ),
        );
    } finally {
        for (const panel of getCreatedWebviewPanels()) panel.dispose();
        resetCreatedWebviewPanelsForTests();
        resetE2eWebviewCaptureSinkForTests();
    }
}
