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
