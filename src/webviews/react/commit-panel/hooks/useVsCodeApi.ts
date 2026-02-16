import type { OutboundMessage } from "../types";
import { getVsCodeApi as getSharedVsCodeApi } from "../../shared/vscodeApi";

interface VsCodeApi {
    postMessage(msg: OutboundMessage): void;
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
}

export function getVsCodeApi(): VsCodeApi {
    return getSharedVsCodeApi<OutboundMessage, Record<string, unknown>>();
}
