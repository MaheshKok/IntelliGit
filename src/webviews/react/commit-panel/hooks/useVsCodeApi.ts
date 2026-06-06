import type { OutboundMessage } from "../types";
import type { CommitGraphOutbound } from "../../../protocol/commitGraphTypes";
import { getVsCodeApi as getSharedVsCodeApi } from "../../shared/vscodeApi";

interface VsCodeApi {
    postMessage(msg: OutboundMessage | CommitGraphOutbound): void;
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
}

/**
 * Returns the typed VS Code webview API bridge used by commit-panel React code.
 *
 * The wrapper keeps commit-panel outbound messages type-checked while allowing
 * the shared undocked shell to forward commit-graph messages through the same
 * acquired VS Code API object.
 */
export function getVsCodeApi(): VsCodeApi {
    return getSharedVsCodeApi<OutboundMessage | CommitGraphOutbound, Record<string, unknown>>();
}
