import * as vscode from "vscode";

import { buildWebviewI18nPayload } from "./catalogs";
export type { WebviewI18nPayload } from "./catalogs";
import type { WebviewI18nPayload } from "./catalogs";

/** Builds the production payload from VS Code's locale and the pseudo-loc environment flag. */
export function getWebviewI18nPayload(locale = vscode.env.language): WebviewI18nPayload {
    return buildWebviewI18nPayload(locale, {
        pseudo: process.env.INTELLIGIT_PSEUDO_LOC === "1",
    });
}
