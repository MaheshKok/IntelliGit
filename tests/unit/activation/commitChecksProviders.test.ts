import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../../../src/services/commitChecks/credentialStore";
import type { ProviderRepoRef } from "../../../src/services/commitChecks/types";

// `https.get` is the one place a request leaves the extension; counting its calls is the check.
const mocks = vi.hoisted(() => ({
    httpsGet: vi.fn(() => {
        throw new Error("a request reached the network");
    }),
    httpsRequest: vi.fn(() => {
        throw new Error("a write reached the network");
    }),
    /** Runs while the GitHub credential is looked up. */
    duringSignIn: vi.fn(),
}));

vi.mock("https", () => ({ get: mocks.httpsGet, request: mocks.httpsRequest }));
vi.mock("vscode", () => ({
    authentication: {
        getSession: async () => {
            mocks.duringSignIn();
            return {
                id: "session",
                accessToken: "gh-token",
                account: { id: "account", label: "GitHub User" },
                scopes: ["repo"],
            };
        },
    },
    l10n: { t: (message: string) => message },
}));

import {
    createCommitChecksProviders,
    writeActionsHelpUrl,
} from "../../../src/activation/commitChecksProviders";
import { CiGenerations } from "../../../src/services/commitChecks/ciGenerations";
import { GitHubProvider } from "../../../src/services/commitChecks/githubProvider";
import { GitLabProvider } from "../../../src/services/commitChecks/gitlabProvider";
import { CommitChecksRequestGateRegistry } from "../../../src/services/commitChecks/requestGate";

const ref = { host: "github.com", owner: "microsoft", repo: "vscode" } as ProviderRepoRef;
const API = "https://api.github.com";

describe("writeActionsHelpUrl", () => {
    it("links the write-actions docs under the repository the manifest names", () => {
        const docs = "/blob/HEAD/docs/commit-checks/README.md#write-actions";
        expect(writeActionsHelpUrl({ repository: { url: "https://github.com/acme/tool" } })).toBe(
            `https://github.com/acme/tool${docs}`,
        );
        expect(writeActionsHelpUrl({ repository: "git+https://github.com/acme/tool.git" })).toBe(
            `https://github.com/acme/tool${docs}`,
        );
        expect(
            writeActionsHelpUrl({ repository: { url: "https://example.com/x/y" } }),
        ).toBeUndefined();
        expect(writeActionsHelpUrl({})).toBeUndefined();
        expect(writeActionsHelpUrl(undefined)).toBeUndefined();
    });
});

describe("createCommitChecksProviders", () => {
    it("sends no GitHub request, detail or scan page, while the gate cools down", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const github = createCommitChecksProviders(
            registry,
            {} as CredentialStore,
            undefined,
            new CiGenerations(),
        ).find((provider) => provider instanceof GitHubProvider) as GitHubProvider;
        expect(github).toBeInstanceOf(GitHubProvider);
        registry.observeResponse("github", {
            url: API,
            statusCode: 429,
            headers: { "retry-after": "60" },
        });

        const detail = await github.getDetail(ref, "abc1234");
        const page = await github.continueFailedScan(ref, {
            runId: "1",
            runAttempt: 1,
            runName: "CI",
            url: `${API}/repos/microsoft/vscode/actions/runs/1/jobs?filter=latest&per_page=100&page=11`,
        });

        expect(
            mocks.httpsGet,
            "no request may leave while the gate cools down",
        ).not.toHaveBeenCalled();
        expect(detail).toMatchObject({ outcome: "unavailable", error: "cooling down" });
        expect(page).toEqual({ pausedUntil: registry.cooldownEnd("github", API) });
    });

    it("pauses a scan page the server answers 429, so it resumes when the cooldown ends", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const github = createCommitChecksProviders(
            registry,
            {} as CredentialStore,
            undefined,
            new CiGenerations(),
        ).find((provider) => provider instanceof GitHubProvider) as GitHubProvider;
        const runUrl = `${API}/repos/microsoft/vscode/actions/runs/1`;
        const pageUrl = `${runUrl}/jobs?filter=latest&per_page=100&page=11`;
        mocks.httpsGet.mockImplementation(((
            url: string,
            _options: unknown,
            cb: (response: unknown) => void,
        ) => {
            // The run check before the page passes; the page itself is rate limited.
            const [statusCode, headers, body] =
                url === pageUrl
                    ? [429, { "retry-after": "60" }, "{}"]
                    : [200, {}, JSON.stringify({ id: 1, run_attempt: 1 })];
            const request = Object.assign(new EventEmitter(), {
                setTimeout: vi.fn(),
                destroy: vi.fn(),
            });
            const response = Object.assign(new EventEmitter(), { statusCode, headers });
            cb(response);
            queueMicrotask(() => {
                response.emit("data", Buffer.from(body));
                response.emit("end");
            });
            return request;
        }) as never);

        const page = await github.continueFailedScan(ref, {
            runId: "1",
            runAttempt: 1,
            runName: "CI",
            url: pageUrl,
        });

        expect(registry.cooldownEnd("github", API)).toBeGreaterThan(0);
        expect(page, "a rate-limited page pauses the scan, never stops it").toEqual({
            pausedUntil: registry.cooldownEnd("github", API),
        });
    });

    it("sends no GitLab detail request or scan page while its gate cools down", async () => {
        mocks.httpsGet.mockClear();
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const store = { get: async () => "glpat-token" } as unknown as CredentialStore;
        const gitlab = createCommitChecksProviders(
            registry,
            store,
            undefined,
            new CiGenerations(),
        ).find((provider) => provider instanceof GitLabProvider) as GitLabProvider;
        const gitlabRef = { host: "gitlab.com", owner: "group", repo: "app" } as ProviderRepoRef;
        const project = "https://gitlab.com/api/v4/projects/group%2Fapp";
        registry.observeResponse("gitlab", {
            url: project,
            statusCode: 429,
            headers: { "retry-after": "60" },
        });

        const detail = await gitlab.getDetail(gitlabRef, "abc1234");
        const page = await gitlab.continueFailedScan(gitlabRef, {
            runId: "7",
            runName: "Build",
            url: `${project}/pipelines/7/jobs?scope[]=failed&per_page=100`,
        });

        expect(
            mocks.httpsGet,
            "no request may leave while the gate cools down",
        ).not.toHaveBeenCalled();
        expect(detail).toMatchObject({ outcome: "unavailable", error: "cooling down" });
        expect(page).toEqual({ pausedUntil: registry.cooldownEnd("gitlab", project) });
    });

    it("write actions run through the gate: a 429 answer cools the API down and the next sends nothing", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const github = createCommitChecksProviders(
            registry,
            {} as CredentialStore,
            undefined,
            new CiGenerations(),
        ).find((provider) => provider instanceof GitHubProvider) as GitHubProvider;
        mocks.httpsRequest.mockImplementation(((
            _url: string,
            _options: unknown,
            cb: (response: unknown) => void,
        ) => {
            const request = Object.assign(new EventEmitter(), {
                setTimeout: vi.fn(),
                destroy: vi.fn(),
                end: vi.fn(),
            });
            const response = Object.assign(new EventEmitter(), {
                statusCode: 429,
                headers: { "retry-after": "60" },
            });
            cb(response);
            queueMicrotask(() => response.emit("end"));
            return request;
        }) as never);
        const beforeSend = vi.fn(async () => undefined);

        await expect(
            github.runAction(ref, { action: "cancel", runId: "1" }, beforeSend),
        ).rejects.toMatchObject({ statusCode: 429 });
        expect(
            registry.cooldownEnd("github", API),
            "the POST's answer is observed",
        ).toBeGreaterThan(0);

        await expect(
            github.runAction(ref, { action: "cancel", runId: "1" }, beforeSend),
        ).rejects.toMatchObject({ until: registry.cooldownEnd("github", API) });
        expect(
            mocks.httpsRequest,
            "nothing is sent while the gate cools down",
        ).toHaveBeenCalledTimes(1);
        expect(beforeSend, "no fence is written while the gate cools down").toHaveBeenCalledTimes(
            1,
        );
    });

    it("a write queued behind the gate sends nothing once the sign-in changed", async () => {
        mocks.httpsRequest.mockClear();
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        const generations = new CiGenerations();
        const github = createCommitChecksProviders(
            registry,
            {} as CredentialStore,
            undefined,
            generations,
        ).find((provider) => provider instanceof GitHubProvider) as GitHubProvider;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const admitted = vi.fn();
        // Four held requests fill the gate, so the write waits in its queue.
        const busy = Array.from({ length: 4 }, () =>
            registry.run("github", API, async () => {
                admitted();
                await held;
            }),
        );
        await vi.waitFor(() => expect(admitted).toHaveBeenCalledTimes(4));
        const queued = vi.spyOn(registry, "run");
        const beforeSend = vi.fn(async () => undefined);
        const action = github
            .runAction(ref, { action: "cancel", runId: "1" }, beforeSend)
            .catch((reason: unknown) => reason);
        await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));

        generations.bumpAuth();
        release();
        await Promise.all(busy);
        const error = await action;

        expect(
            mocks.httpsRequest,
            "the production HTTP boundary must not run after sign-out",
        ).not.toHaveBeenCalled();
        expect(error).toMatchObject({ name: "RequestNotSentError", superseded: true });
    });

    /** Both write-capable providers, built over one gate the way the extension builds them. */
    function writers(registry: CommitChecksRequestGateRegistry, onToken: () => void = () => {}) {
        const store = {
            get: async () => {
                onToken();
                return "glpat-token";
            },
        } as unknown as CredentialStore;
        const all = createCommitChecksProviders(registry, store, undefined, new CiGenerations());
        return [
            {
                provider: all.find((p) => p instanceof GitHubProvider) as GitHubProvider,
                ref,
                api: API,
            },
            {
                provider: all.find((p) => p instanceof GitLabProvider) as GitLabProvider,
                ref: { host: "gitlab.com", owner: "group", repo: "app" } as ProviderRepoRef,
                api: "https://gitlab.com/api/v4/projects/group%2Fapp",
            },
        ] as const;
    }

    it("a queued write runs its pre-send check once admitted, so a change in the queue sends nothing", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        for (const { provider, ref: target, api } of writers(registry)) {
            mocks.httpsRequest.mockClear();
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const admitted = vi.fn();
            const busy = Array.from({ length: 4 }, () =>
                registry.run(provider.id, api, async () => {
                    admitted();
                    await held;
                }),
            );
            await vi.waitFor(() => expect(admitted).toHaveBeenCalledTimes(4));
            // Stands in for the fence write and the live repository and provider check.
            let current = true;
            const beforeSend = vi.fn(async () => {
                if (!current) throw new Error("Remote data changed.");
            });
            const action = provider
                .runAction(target, { action: "cancel", runId: "1" }, beforeSend)
                .catch((reason: unknown) => reason);
            await new Promise((resolve) => setTimeout(resolve, 0));

            current = false;
            release();
            await Promise.all(busy);
            await action;

            expect(
                mocks.httpsRequest,
                `${provider.id}: no POST after the context changed in the queue`,
            ).not.toHaveBeenCalled();
        }
    });

    it("a cooldown starting during the credential lookup writes no fence and sends nothing", async () => {
        const registry = new CommitChecksRequestGateRegistry("cooling down");
        let target = "";
        const coolDown = () =>
            registry.observeResponse(target === API ? "github" : "gitlab", {
                url: target,
                statusCode: 429,
                headers: { "retry-after": "60" },
            });
        mocks.duringSignIn.mockImplementation(coolDown);
        for (const { provider, ref: repo, api } of writers(registry, coolDown)) {
            mocks.httpsRequest.mockClear();
            target = api;
            const beforeSend = vi.fn(async () => undefined);

            const error = await provider
                .runAction(repo, { action: "cancel", runId: "1" }, beforeSend)
                .catch((reason: unknown) => reason);

            expect(error, provider.id).toMatchObject({
                until: registry.cooldownEnd(provider.id, api),
            });
            expect(
                beforeSend,
                `${provider.id}: a bucket in cooldown must not write a fence`,
            ).not.toHaveBeenCalled();
            expect(mocks.httpsRequest, provider.id).not.toHaveBeenCalled();
        }
        mocks.duringSignIn.mockReset();
    });

    it("a busy signed log host does not cool the GitHub API down; a busy API does", async () => {
        const logsUrl = `${API}/repos/microsoft/vscode/actions/jobs/77/logs`;
        const blobUrl = "https://results-receiver.actions.githubusercontent.com/logs/77?sig=abc";
        type Answer = { statusCode: number; headers: Record<string, string> };
        const busy: Answer = { statusCode: 429, headers: { "retry-after": "60" } };
        const readLog = async (answers: Record<string, Answer>) => {
            mocks.httpsGet.mockImplementation(((
                url: string,
                _options: unknown,
                cb: (response: unknown) => void,
            ) => {
                const answer = answers[url];
                if (!answer) throw new Error(`unexpected request ${url}`);
                const request = Object.assign(new EventEmitter(), {
                    setTimeout: vi.fn(),
                    destroy: vi.fn(),
                });
                const response = Object.assign(new EventEmitter(), {
                    ...answer,
                    resume: vi.fn(),
                    destroy: vi.fn(),
                });
                queueMicrotask(() => cb(response));
                return request;
            }) as never);
            const registry = new CommitChecksRequestGateRegistry("cooling down");
            const github = createCommitChecksProviders(
                registry,
                {} as CredentialStore,
                undefined,
                new CiGenerations(),
            ).find((provider) => provider instanceof GitHubProvider) as GitHubProvider;
            const error = await github
                .getJobLog(
                    ref,
                    { runId: "5", jobId: "77", attempt: 1 },
                    new AbortController().signal,
                )
                .catch((reason: unknown) => reason);
            expect(error).toMatchObject({ statusCode: 429 });
            return registry.cooldownEnd("github", API);
        };

        expect(
            await readLog({
                [logsUrl]: { statusCode: 302, headers: { location: blobUrl } },
                [blobUrl]: busy,
            }),
            "the signed log host's limit is not the API's",
        ).toBe(0);
        expect(
            await readLog({ [logsUrl]: busy }),
            "the API's own limit cools it down",
        ).toBeGreaterThan(0);
    });
});
