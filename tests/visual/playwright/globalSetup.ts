import path from "node:path";

import { WEBVIEW_HOST_CONTEXTS } from "../harness/hostContexts";
import { assertRequiredDistAssets, requiredDistAssets } from "./visualHarnessUtils";

/** Fails before collection when a production bundle needed by the visual matrix is absent. */
export default async function visualGlobalSetup(): Promise<void> {
    const distDir = path.resolve(__dirname, "../../..", "dist");
    assertRequiredDistAssets(distDir, requiredDistAssets(WEBVIEW_HOST_CONTEXTS));
}
