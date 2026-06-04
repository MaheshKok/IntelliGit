import type { OutboundMessage } from "../types";
import type { CommitGraphOutbound } from "../../../protocol/commitGraphTypes";
import { getVsCodeApi as getSharedVsCodeApi } from "../../shared/vscodeApi";

interface VsCodeApi {
    postMessage(msg: OutboundMessage | CommitGraphOutbound): void;
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
}

export function getVsCodeApi(): VsCodeApi {
    return getSharedVsCodeApi<OutboundMessage | CommitGraphOutbound, Record<string, unknown>>();
}
