// Phase 9 review round 1: C2 maps every 403 on branch protection, a rate-limited one included.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { interpolateL10n } from "../../../helpers/l10nTestHelper";
import {
    HttpError,
    type FetchJson,
    type FetchJsonWithMeta,
} from "../../../../src/services/commitChecks/http";
import type { ProviderRepoRef } from "../../../../src/services/commitChecks/types";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("vscode", () => ({
    authentication: { getSession: mocks.getSession },
    l10n: { t: interpolateL10n },
}));

import { GitHubProvider } from "../../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../../src/services/commitChecks/gitlabProvider";
import { RequiredChecksCache } from "../../../../src/services/commitChecks/requiredChecks";

const ghRef = { host: "github.com", owner: "octo", repo: "app" } as ProviderRepoRef;

const buildRule = [
    {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "build" }] },
    },
];

function providerWith(protectionError: HttpError) {
    const fetchWithMeta: FetchJsonWithMeta = vi.fn(async () => ({
        statusCode: 200,
        headers: {},
        body: buildRule,
    }));
    const fetchJson: FetchJson = vi.fn(async () => {
        throw protectionError;
    });
    return new GitHubProvider(fetchJson, undefined, fetchWithMeta);
}

describe("C2 every protection 403", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSession.mockResolvedValue({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        });
    });

    it("C2 every protection 403 retains readable rules as partial", async () => {
        const limited = new HttpError(403, "HTTP 403: API rate limit exceeded", {
            "x-ratelimit-remaining": "0",
        });

        await expect(providerWith(limited).getRequiredChecks(ghRef, "trunk")).resolves.toEqual({
            status: "partial",
            names: ["build"],
        });
    });

    it("C2 every protection 403 with a retry-after header also maps instead of throwing", async () => {
        const secondary = new HttpError(403, "HTTP 403: secondary rate limit", {
            "retry-after": "60",
        });

        await expect(providerWith(secondary).getRequiredChecks(ghRef, "trunk")).resolves.toEqual({
            status: "partial",
            names: ["build"],
        });
    });
});

describe("required checks and the GitHub sign-in", () => {
    beforeEach(() => vi.clearAllMocks());

    it("a sign-in that fails once is read again after it recovers, not kept for the hour", async () => {
        const provider = providerWith(
            new HttpError(404, `HTTP 404: {"message":"Branch not protected"}`),
        );
        const cache = new RequiredChecksCache(() => 0);
        const read = () =>
            cache.get("octo/app", "trunk", () => provider.getRequiredChecks(ghRef, "trunk"));
        mocks.getSession.mockRejectedValueOnce(new Error("keychain locked"));
        mocks.getSession.mockResolvedValue({
            id: "session",
            accessToken: "gh-token",
            account: { id: "account", label: "GitHub User" },
            scopes: ["repo"],
        });

        await read().catch(() => undefined);

        expect(
            (await read()).status,
            "a failed sign-in read must not stay cached as unknown",
        ).not.toBe("unknown");
    });

    it("no GitHub session answers unknown", async () => {
        mocks.getSession.mockResolvedValue(undefined);

        await expect(
            providerWith(
                new HttpError(404, `HTTP 404: {"message":"Branch not protected"}`),
            ).getRequiredChecks(ghRef, "trunk"),
        ).resolves.toEqual({ status: "unknown" });
    });
});

describe("required checks and the GitLab token store", () => {
    const glRef = { host: "gitlab.com", owner: "group", repo: "app" } as ProviderRepoRef;
    const gitlabWith = (get: () => Promise<string | undefined>) =>
        new GitLabProvider(
            vi.fn(async () => ({ only_allow_merge_if_pipeline_succeeds: true })),
            { get } as never,
        );

    it("a token store that fails once is read again after it recovers, not kept for the hour", async () => {
        const get = vi
            .fn<() => Promise<string | undefined>>()
            .mockRejectedValueOnce(new Error("keychain locked"))
            .mockResolvedValue("gl-token");
        const provider = gitlabWith(get);
        const cache = new RequiredChecksCache(() => 0);
        const read = () =>
            cache.get("group/app", "trunk", () => provider.getRequiredChecks(glRef, "trunk"));

        await read().catch(() => undefined);

        expect(
            (await read()).status,
            "a failed token-store read must not stay cached as unknown",
        ).toBe("known");
    });

    it("no GitLab token answers unknown", async () => {
        await expect(
            gitlabWith(async () => undefined).getRequiredChecks(glRef, "trunk"),
        ).resolves.toEqual({ status: "unknown" });
    });
});
