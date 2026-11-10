import { describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import type { FetchResponse } from "../../../../src/services/commitChecks/http";

vi.mock("vscode", () => ({ l10n: { t: interpolateL10n } }));
import {
    isUnderApiPrefix,
    linkHeaderNext,
    paginate,
} from "../../../../src/services/commitChecks/paginate";

const BASE = "https://api.test/repos/o/r/items";

/** Pages 1..`last` of `perPage` numbered items, each linking to the next by `Link`. */
function pagedFetch(last: number, perPage = 2, nextOf = (page: number) => `${BASE}?page=${page}`) {
    return vi.fn(async (url: string): Promise<FetchResponse> => {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        const items = Array.from({ length: perPage }, (_, i) => (page - 1) * perPage + i + 1);
        return {
            statusCode: 200,
            headers: page < last ? { link: `<${nextOf(page + 1)}>; rel="next"` } : {},
            body: { items },
        };
    });
}

const itemsOf = (body: unknown): number[] => (body as { items: number[] }).items;
const allowAll = (): boolean => true;

describe("paginate", () => {
    it("follows Link until no next", async () => {
        const fetch = pagedFetch(3);
        const result = await paginate(fetch, BASE, linkHeaderNext, itemsOf, 10, allowAll);
        expect(result).toEqual({ items: [1, 2, 3, 4, 5, 6], coverage: "full" });
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("stops at maxPages and sets pageBound coverage", async () => {
        const fetch = pagedFetch(5);
        const result = await paginate(fetch, BASE, linkHeaderNext, itemsOf, 2, allowAll);
        expect(result).toEqual({
            items: [1, 2, 3, 4],
            coverage: { reason: "pageBound", shown: 4 },
            next: `${BASE}?page=3`,
        });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("rejected next link stops paging, sends nothing and sets rejectedNext", async () => {
        const fetch = pagedFetch(3, 2, (page) => `https://evil.test/steal?page=${page}`);
        const allowNext = vi.fn((url: string) => url.startsWith("https://api.test/"));
        const result = await paginate(fetch, BASE, linkHeaderNext, itemsOf, 10, allowNext);
        expect(result).toEqual({ items: [1, 2], coverage: { reason: "rejectedNext", shown: 2 } });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([BASE]);
        expect(allowNext).toHaveBeenCalledWith("https://evil.test/steal?page=2");
    });

    it("a hostile link at the page bound is refused, not handed on as the next cursor", async () => {
        const fetch = pagedFetch(3, 2, (page) => `https://evil.test/steal?page=${page}`);
        const result = await paginate(fetch, BASE, linkHeaderNext, itemsOf, 1, () => false);
        expect(result).toEqual({ items: [1, 2], coverage: { reason: "rejectedNext", shown: 2 } });
    });

    it("any page failure rejects", async () => {
        const fetch = vi.fn(async (url: string): Promise<FetchResponse> => {
            if (url.includes("page=2")) throw new Error("boom");
            return {
                statusCode: 200,
                headers: { link: `<${BASE}?page=2>; rel="next"` },
                body: { items: [1] },
            };
        });
        await expect(paginate(fetch, BASE, linkHeaderNext, itemsOf, 10, allowAll)).rejects.toThrow(
            "boom",
        );
    });

    it("follows a next URL with a comma inside <...> and never reports full before the last page", async () => {
        const nextOf = (page: number) => `${BASE}?page=${page}&filter=a,b`;
        const fetch = pagedFetch(3, 2, nextOf);
        const result = await paginate(fetch, BASE, linkHeaderNext, itemsOf, 10, allowAll);
        expect(result).toEqual({ items: [1, 2, 3, 4, 5, 6], coverage: "full" });
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([BASE, nextOf(2), nextOf(3)]);

        const bounded = await paginate(
            pagedFetch(3, 2, nextOf),
            BASE,
            linkHeaderNext,
            itemsOf,
            1,
            allowAll,
        );
        expect(bounded).toEqual({
            items: [1, 2],
            coverage: { reason: "pageBound", shown: 2 },
            next: nextOf(2),
        });
    });

    it("a rel= inside a quoted parameter neither hides the next page nor fakes one", async () => {
        const page2 = `${BASE}?page=2`;
        const links: Record<string, string> = {
            [BASE]: `<${page2}>; title="text; rel=prev"; rel="next last"`,
            [page2]: `<${BASE}>; title="see; rel=next"; rel="first"`,
        };
        const fetch = vi.fn(async (url: string): Promise<FetchResponse> => ({
            statusCode: 200,
            headers: { link: links[url] },
            body: { items: url === BASE ? [1, 2] : [3, 4] },
        }));
        const result = await paginate(fetch, BASE, linkHeaderNext, itemsOf, 10, allowAll);
        expect(result).toEqual({ items: [1, 2, 3, 4], coverage: "full" });
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([BASE, page2]);
    });
});

describe("linkHeaderNext", () => {
    it("reads rel=next among other relations and ignores a missing header", () => {
        const response = (link?: string | string[]): FetchResponse => ({
            statusCode: 200,
            headers: { link },
            body: {},
        });
        expect(
            linkHeaderNext(
                response(
                    '<https://a.test/x?page=1>; rel="prev", <https://a.test/x?page=3>; rel="next", <https://a.test/x?page=9>; rel="last"',
                ),
            ),
        ).toBe("https://a.test/x?page=3");
        expect(linkHeaderNext(response('<https://a.test/x?page=9>; rel="last"'))).toBeUndefined();
        expect(linkHeaderNext(response())).toBeUndefined();
    });

    it("keeps commas inside <...> as part of the URL", () => {
        const response = (link: string): FetchResponse => ({
            statusCode: 200,
            headers: { link },
            body: {},
        });
        expect(
            linkHeaderNext(
                response(
                    '<https://a.test/x?page=1&f=a,b>; rel="prev", <https://a.test/x?page=3&f=a,b>; rel="next"',
                ),
            ),
        ).toBe("https://a.test/x?page=3&f=a,b");
    });

    it("reads rel only from its own parameter, never from inside a quoted value", () => {
        const next = (link: string): string | undefined =>
            linkHeaderNext({ statusCode: 200, headers: { link }, body: {} });
        // Hidden: the quoted title holds `rel=prev` before the real `rel`.
        expect(next('<https://a.test/x?page=2>; title="text; rel=prev"; rel="next last"')).toBe(
            "https://a.test/x?page=2",
        );
        // Faked: the quoted title holds `rel=next`; the real relation is prev.
        expect(next('<https://a.test/x?page=1>; title="x; rel=next"; rel="prev"')).toBeUndefined();
        // Faked: a `<...>` inside a quoted title is not a link target.
        expect(next('<https://a.test/x?page=1>; title="a <b> c"; rel="next"')).toBe(
            "https://a.test/x?page=1",
        );
        // Escaped quotes stay inside the value; only the first rel counts (RFC 8288 §3.3).
        expect(next('<https://a.test/x?page=4>; title="q\\"; rel=prev"; rel=next; rel=prev')).toBe(
            "https://a.test/x?page=4",
        );
        // An unterminated quote cannot be read, so it never passes as "no next page".
        expect(() => next('<https://a.test/x?page=1>; title="open; rel=next')).toThrow(
            "Malformed Link header.",
        );
    });

    it("an empty value or an empty relation cannot be read, so it never passes as the last page", () => {
        const next = (link: string): string | undefined =>
            linkHeaderNext({ statusCode: 200, headers: { link }, body: {} });
        // RFC 8288 §3: a value after `=` is a token or a quoted string; a relation needs a type.
        for (const param of ["rel=", "rel", 'rel=""', 'rel="  "', "title=", "title=; rel=next"]) {
            expect(() => next(`<https://a.test/x?page=2>; ${param}`), param).toThrow(
                "Malformed Link header.",
            );
        }
        // A parameter with no value other than rel stays valid.
        expect(next("<https://a.test/x?page=2>; crossorigin; rel=next")).toBe(
            "https://a.test/x?page=2",
        );
    });

    it("link-values with no comma between them cannot be read, so paging never continues on them", () => {
        const next = (link: string | string[]): string | undefined =>
            linkHeaderNext({ statusCode: 200, headers: { link }, body: {} });
        // RFC 8288 §3: Link = #link-value, so every value after the first follows a comma.
        for (const link of [
            '<https://a.test/x?page=1>; rel="prev" <https://a.test/x?page=3>; rel="next"',
            '<https://a.test/x?page=1><https://a.test/x?page=3>; rel="next"',
        ]) {
            expect(() => next(link), link).toThrow("Malformed Link header.");
        }
        // Separate header lines are joined with a comma, so they stay readable.
        expect(
            next([
                '<https://a.test/x?page=1>; rel="prev"',
                '<https://a.test/x?page=3>; rel="next"',
            ]),
        ).toBe("https://a.test/x?page=3");
    });
});

describe("isUnderApiPrefix", () => {
    const prefixes = ["/repos/o/r/"];
    it("accepts the API origin under the prefix only", () => {
        const allow = (url: string): boolean => isUnderApiPrefix(url, "https://api.test", prefixes);
        expect(allow("https://api.test/repos/o/r/actions/runs?page=2")).toBe(true);
        expect(allow("https://API.test:443/repos/o/r/x")).toBe(true);
        expect(allow("http://api.test/repos/o/r/x")).toBe(false);
        expect(allow("https://evil.test/repos/o/r/x")).toBe(false);
        expect(allow("https://api.test:8443/repos/o/r/x")).toBe(false);
        expect(allow("https://api.test/repos/o/other/x")).toBe(false);
        expect(allow("https://api.test/repos/o/r/../../other/x")).toBe(false);
        expect(allow("https://user:pass@api.test/repos/o/r/x")).toBe(false);
        expect(allow("not a url")).toBe(false);
    });
});
