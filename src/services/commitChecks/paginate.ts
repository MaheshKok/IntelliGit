// Bounded, guarded pagination for CI detail collections (plan §3, O1, K33, K36).

import * as vscode from "vscode";
import type { CiCoverage } from "../../types";
import type { FetchResponse } from "./http";

/** Items asked for on every bounded collection request (K36). */
export const CI_PAGE_SIZE = 100;
/** Pages read per collection before coverage becomes `pageBound` (O1: 10 × 100 items). */
export const CI_MAX_PAGES = 10;

/** The items read, their coverage, and the unread next page when the bound stopped paging. */
export interface PaginateResult<T> {
    readonly items: T[];
    readonly coverage: CiCoverage;
    /** The allowed next-page URL left unread when the page bound was reached. */
    readonly next?: string;
}

/**
 * Reads pages one at a time until there is no next page, the page bound, or a refused next link.
 *
 * A refused link is never requested, so credentials sent to the first URL never leave the API.
 * Any page failure rejects; callers map that to an unavailable result, never a partial tree.
 */
export async function paginate<T>(
    fetch: (url: string) => Promise<FetchResponse>,
    firstUrl: string,
    nextUrl: (response: FetchResponse) => string | undefined,
    itemsOf: (body: unknown) => T[],
    maxPages: number,
    allowNext: (url: string) => boolean,
): Promise<PaginateResult<T>> {
    const items: T[] = [];
    let url = firstUrl;
    for (let page = 1; ; page++) {
        const response = await fetch(url);
        items.push(...itemsOf(response.body));
        const next = nextUrl(response);
        if (next === undefined) return { items, coverage: "full" };
        // Checked before the page bound so a hostile link is never handed on as a scan cursor.
        if (!allowNext(next)) {
            return { items, coverage: { reason: "rejectedNext", shown: items.length } };
        }
        if (page >= maxPages) {
            return { items, coverage: { reason: "pageBound", shown: items.length }, next };
        }
        url = next;
    }
}

/** The `rel="next"` target of an RFC 8288 `Link` response header, if any. */
export function linkHeaderNext(response: FetchResponse): string | undefined {
    const raw = response.headers.link;
    const header = Array.isArray(raw) ? raw.join(",") : raw;
    if (!header) return undefined;
    for (const { uri, rel } of linkEntries(header)) {
        if (rel?.toLowerCase().split(/\s+/).includes("next")) return uri;
    }
    return undefined;
}

/**
 * Each `<uri>` of a Link header with its first `rel` (RFC 8288 §3.3). The URI may hold commas
 * and a quoted value may hold `;`, `,`, `<` or `rel=`, so both are read whole. A header that
 * does not parse (an empty unquoted value or an empty relation included) throws, so a page
 * whose next link cannot be read never counts as the last.
 */
function linkEntries(header: string): { uri: string; rel?: string }[] {
    const entry = /([\s,]*)<([^>]*)>/y;
    const param = /\s*;\s*([^\s;,=]+)\s*(?:=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;,"]+)))?/y;
    const entries: { uri: string; rel?: string }[] = [];
    let at = 0;
    for (;;) {
        entry.lastIndex = at;
        const target = entry.exec(header);
        if (!target) break;
        // Link = #link-value (RFC 8288 §3): every value after the first follows a comma.
        if (entries.length > 0 && !target[1].includes(",")) throw malformedLinkHeader();
        at = entry.lastIndex;
        let rel: string | undefined;
        for (;;) {
            param.lastIndex = at;
            const match = param.exec(header);
            if (!match) break;
            at = param.lastIndex;
            if (rel === undefined && match[1].toLowerCase() === "rel") {
                rel = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
                // A relation names at least one type (RFC 8288 §3.3); an empty one is unreadable.
                if (!rel.trim()) throw malformedLinkHeader();
            }
        }
        entries.push({ uri: target[2], rel });
    }
    if (!/^[\s,]*$/.test(header.slice(at))) throw malformedLinkHeader();
    return entries;
}

/** Its message becomes the detail's or the scan's error text, so it is shown translated. */
function malformedLinkHeader(): Error {
    return new Error(vscode.l10n.t("Malformed Link header."));
}

/**
 * Continuation guard (K33): `https:`, the API base's host and port, no user info, and a path
 * under one of `prefixes`. `URL` resolves dot segments first, so `..` cannot climb out.
 */
export function isUnderApiPrefix(
    url: string,
    apiBase: string,
    prefixes: readonly string[],
): boolean {
    let target: URL;
    let base: URL;
    try {
        target = new URL(url);
        base = new URL(apiBase);
    } catch {
        return false;
    }
    return (
        target.protocol === "https:" &&
        target.host === base.host &&
        target.username === "" &&
        target.password === "" &&
        prefixes.some((prefix) => target.pathname.startsWith(prefix))
    );
}
