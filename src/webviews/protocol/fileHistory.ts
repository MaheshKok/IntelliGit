import type { FileHistoryEntry } from "../../git/fileHistoryTypes";
import type { DiffViewerData } from "./diffViewerTypes";

/** A root-bound history snapshot; paths and hashes remain host-validated. */
export interface FileHistoryState {
    path: string;
    root: string;
    ref: string;
    entries: FileHistoryEntry[];
    hasMore: boolean;
    branches: string[];
    labels: Record<string, string>;
}

/** Messages accepted by the standalone history host. */
export type HistoryOutbound =
    | { type: "historyReady" }
    | { type: "historyRefresh"; ref?: string }
    | { type: "historyMore" }
    | {
          type: "historySelect";
          hashes: string[];
          requestId: number;
          local?: boolean;
          ignoreWhitespace?: boolean;
      }
    | { type: "historyAction"; action: "copy" | "open" | "diff" | "affected"; hash: string };

/** History responses carry a preview request identifier to reject stale selection results. */
export type HistoryInbound =
    | { type: "historyState"; state: FileHistoryState }
    | { type: "historyError"; message: string }
    | { type: "historyDiff"; requestId: number; data?: DiffViewerData; error?: string };
