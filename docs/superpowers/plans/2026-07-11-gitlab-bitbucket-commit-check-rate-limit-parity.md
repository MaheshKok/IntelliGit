# GitLab and Bitbucket Commit-Check Rate-Limit Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Extend the existing idle-safe commit-check safeguards so GitLab, Bitbucket Cloud, and Bitbucket Server/Data Center receive provider-appropriate concurrency, request-budget, and rate-limit cooldown protection.

**Architecture:** Leave visible-row demand, host protocol, coordinator, shared runtime cache, persistent cache, and provider result parsing unchanged: they already serve all four providers. Replace the GitHub-only HTTP wrapper with one activation-scoped registry that owns a long-lived request gate for each provider/API-origin pair. It honors generic HTTP 429/Retry-After signals everywhere, GitLab quota headers, and Bitbucket Cloud NearLimit metadata without guessing a self-hosted server quota.

**Tech Stack:** TypeScript strict mode, VS Code extension host https client, Vitest/Bun, static localization catalogs.

---

## Verified baseline

Already shared across GitHub, GitLab, Bitbucket Cloud, and Bitbucket Server/Data Center:

- Exact-visible-row demand, hide/unmount/disable teardown, generation guards, and bounded pending/current-HEAD retries.
- CommitChecksCoordinator's provider-scoped cache key and shared CommitChecksService L1/in-flight de-duplication.
- Persistent terminal/none-result behavior and provider-specific provider toggles.

Only proactive quota protection is GitHub-only. In src/activation/repositoryMode.ts, GitHubProvider receives gatedGithubFetchJson. GitLabProvider, BitbucketCloudProvider, and BitbucketServerProvider receive bare httpGetJson, so their HTTP 429 response becomes unavailable but leaves other automatic requests running.

Provider facts and fixed design decisions:

| Provider | Response signal to honor | Decision |
| --- | --- | --- |
| GitHub | x-ratelimit-remaining, x-ratelimit-reset, Retry-After, secondary-limit 403 | Preserve the current reserve/cooldown semantics. |
| GitLab | RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After on 429 | Stop at a 10% server-reported reserve; never assume a fixed instance quota. |
| Bitbucket Cloud | X-RateLimit-NearLimit true, X-RateLimit-Limit where supplied, Retry-After on 429 | Pause that API origin for one hour after NearLimit because its documented window is rolling one hour. |
| Bitbucket Server/Data Center | 429 and optional Retry-After; instance admin settings vary | Respect Retry-After, otherwise pause 60 seconds. Never infer a quota from a bare 403. |

References: [GitLab rate-limit headers](https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/), [Bitbucket Cloud API limits](https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/), and [Bitbucket Data Center rate-limit administration](https://developer.atlassian.com/server/bitbucket/rest/v803/api-group-api/).

Non-goals: no GraphQL/batching/retries/telemetry/new dependency/new settings/provider API rewrite. A bare GitLab or Bitbucket 403 remains authentication/unavailable, not a cooldown signal.

## Target contract

The gate key is provider plus HTTPS API origin:

~~~ts
function gateKey(providerId: ProviderId, url: string): string {
    return `${providerId}:${new URL(url).origin.toLowerCase()}`;
}
~~~

That makes all GitHub requests share api.github.com, all Bitbucket Cloud requests share api.bitbucket.org, and distinct self-hosted GitLab/Data Center origins independent.

Every gate uses the existing safe limits:

- maximum 4 concurrent outbound HTTP calls;
- maximum 300 automatic starts per rolling hour;
- a cooldown stops queued/future work before HTTP starts;
- cache behavior and provider snapshots remain unchanged.

A gate cooldown continues to surface through the existing unavailable snapshot path. The new generic cooldown message must be localized; do not add an untranslated user-visible string.

### Task 1: Add provider-policy tests before implementation

**Files:**
- Modify: tests/unit/services/commitChecks/requestGate.test.ts
- Modify: src/services/commitChecks/requestGate.ts

- [ ] **Step 1: Add deterministic registry test helpers**

~~~ts
const NOW = 1_700_000_000_000;

function registryAt(now = NOW): CommitChecksRequestGateRegistry {
    return new CommitChecksRequestGateRegistry(
        "Commit-check requests are temporarily paused due to rate limiting.",
        () => now,
    );
}

function metadata(
    url = "https://api.example.test/checks",
    headers: Record<string, string> = {},
    statusCode = 200,
): HttpResponseMetadata {
    return { url, statusCode, headers };
}
~~~

- [ ] **Step 2: Write failing GitLab, Bitbucket Cloud, and Data Center tests**

~~~ts
it("blocks a GitLab API origin at its header-reported 10% reserve", async () => {
    const gates = registryAt();
    gates.observeResponse("gitlab", metadata("https://gitlab.acme.test/api/v4/x", {
        "ratelimit-limit": "100",
        "ratelimit-remaining": "10",
        "ratelimit-reset": String((NOW + 60_000) / 1000),
    }));

    await expect(
        gates.run("gitlab", "https://gitlab.acme.test/api/v4/x", async () => {}),
    ).rejects.toMatchObject({ statusCode: 429 });
});

it("pauses Bitbucket Cloud when NearLimit is true", async () => {
    const gates = registryAt();
    gates.observeResponse(
        "bitbucket-cloud",
        metadata("https://api.bitbucket.org/2.0/x", { "x-ratelimit-nearlimit": "true" }),
    );

    await expect(
        gates.run("bitbucket-cloud", "https://api.bitbucket.org/2.0/x", async () => {}),
    ).rejects.toMatchObject({ statusCode: 429 });
});

it("uses Retry-After for a Data Center 429 and ignores a bare 403", async () => {
    const gates = registryAt();

    await expect(
        gates.run("bitbucket-server", "https://bb.acme.test/rest/x", async (generation) => {
            gates.observeResponse(
                "bitbucket-server",
                metadata("https://bb.acme.test/rest/x", { "retry-after": "120" }, 429),
                generation,
            );
            throw new HttpError(429, "HTTP 429", { "retry-after": "120" });
        }),
    ).rejects.toMatchObject({ statusCode: 429 });

    await expect(
        gates.run("bitbucket-server", "https://bb.acme.test/rest/x", async () => {}),
    ).rejects.toMatchObject({ statusCode: 429 });

    const fresh = registryAt();
    await expect(
        fresh.run("bitbucket-server", "https://bb.acme.test/rest/x", async (generation) => {
            fresh.observeResponse(
                "bitbucket-server",
                metadata("https://bb.acme.test/rest/x", {}, 403),
                generation,
            );
            throw new HttpError(403, "HTTP 403", {});
        }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
        fresh.run("bitbucket-server", "https://bb.acme.test/rest/x", async () => {}),
    ).resolves.toBeUndefined();
});
~~~

Add host-isolation coverage: two URLs on one GitLab origin share a cooldown; a different GitLab origin remains runnable. Retain existing GitHub concurrency, 300/hour, reserve, and expiry regressions.

- [ ] **Step 3: Prove the red state**

Run:

~~~bash
bun vitest run tests/unit/services/commitChecks/requestGate.test.ts
~~~

Expected: FAIL because CommitChecksRequestGateRegistry and non-GitHub response policies do not exist.

### Task 2: Generalize the gate without moving logic into providers

**Files:**
- Modify: src/services/commitChecks/requestGate.ts
- Test: tests/unit/services/commitChecks/requestGate.test.ts

- [ ] **Step 1: Replace GitHubRequestGate with a provider-aware gate plus registry**

Keep the semaphore, FIFO waiter queue, rolling start timestamps, and cooldown state in one small gate. Add only the registry required for host isolation.

~~~ts
export class CommitChecksRequestGateRegistry {
    private readonly gates = new Map<string, ProviderRequestGate>();

    constructor(
        private readonly cooldownMessage: string,
        private readonly now: () => number = Date.now,
    ) {}

    run<T>(
        providerId: ProviderId,
        url: string,
        task: (generation: number) => Promise<T>,
    ): Promise<T> {
        return this.gateFor(providerId, url).run(task);
    }

    observeResponse(
        providerId: ProviderId,
        response: HttpResponseMetadata,
        generation?: number,
    ): void {
        const key = gateKey(providerId, response.url);
        const gate = this.gates.get(key);
        if (gate) {
            gate.observeResponse(response, generation);
            return;
        }
        if (generation === undefined) this.gateFor(providerId, response.url).observeResponse(response);
    }

    reset(): void {
        for (const [key, gate] of this.gates) {
            gate.reset();
            if (gate.isIdle()) this.gates.delete(key);
        }
    }

    private gateFor(providerId: ProviderId, url: string): ProviderRequestGate {
        const key = gateKey(providerId, url);
        let gate = this.gates.get(key);
        if (!gate) {
            gate = new ProviderRequestGate(
                providerId,
                MAX_CONCURRENT_REQUESTS,
                this.cooldownMessage,
                this.now,
            );
            this.gates.set(key, gate);
        }
        return gate;
    }
}
~~~

- [ ] **Step 2: Add pure response-deadline helpers**

~~~ts
function readRetryAfterUntil(
    headers: Record<string, string | string[] | undefined>,
    now: () => number,
): number | undefined {
    const raw = firstHeaderValue(headers, "retry-after");
    if (!raw) return undefined;

    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return now() + seconds * 1000;

    const date = Date.parse(raw);
    return Number.isFinite(date) && date > now() ? date : undefined;
}

function isBitbucketNearLimit(
    headers: Record<string, string | string[] | undefined>,
): boolean {
    return firstHeaderValue(headers, "x-ratelimit-nearlimit")?.toLowerCase() === "true";
}
~~~

The per-provider decision flow is:

1. Any HTTP 429: use Retry-After first; otherwise GitHub/GitLab use a future reset header; otherwise use the 60-second fallback.
2. GitHub only: preserve existing 403 retry/reset behavior and its 100-or-10%-reserve rule.
3. GitLab only: use RateLimit-Limit/Remaining/Reset; reserve is max(1, ceil(limit * 0.10)).
4. Bitbucket Cloud only: a successful NearLimit header arms a one-hour cooldown.
5. Never arm a non-GitHub cooldown from a 403.

- [ ] **Step 3: Keep budget/concurrency behavior provider-neutral**

The existing automatic 300/hour cap and four-request semaphore must run before every provider HTTP task. A cooldown error must be:

~~~ts
throw new HttpError(429, this.cooldownMessage, {});
~~~

The caller-provided localized message is the only new user-visible text. Do not import vscode into requestGate.ts.

- [ ] **Step 4: Verify focused gate behavior**

Run:

~~~bash
bun vitest run tests/unit/services/commitChecks/requestGate.test.ts
~~~

Expected: PASS for GitHub regression coverage, GitLab reserve/reset handling, Bitbucket Cloud NearLimit, Data Center 429 fallback, Retry-After seconds/date parsing, and provider/API-origin isolation.

- [ ] **Step 5: Commit**

~~~bash
git add src/services/commitChecks/requestGate.ts tests/unit/services/commitChecks/requestGate.test.ts
git commit -m "feat(commit-checks): gate GitLab and Bitbucket requests"
~~~

### Task 3: Carry the request URL through HTTP response metadata

**Files:**
- Modify: src/services/commitChecks/http.ts
- Test: tests/unit/services/commitChecks/http.test.ts

- [ ] **Step 1: Write a failing observer-contract test**

~~~ts
expect(onResponse).toHaveBeenCalledWith({
    url: "https://api.example.test/checks",
    statusCode: 200,
    headers: expect.objectContaining({ "x-test": "ok" }),
});
~~~

Run:

~~~bash
bun vitest run tests/unit/services/commitChecks/http.test.ts
~~~

Expected: FAIL because HttpResponseMetadata lacks url.

- [ ] **Step 2: Add the URL exactly once at the transport boundary**

~~~ts
export interface HttpResponseMetadata {
    url: string;
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
}

// In createHttpGetJson:
onResponse?.({ url, statusCode, headers: res.headers });
~~~

Call the observer before rejecting a non-2xx response. That lets a 429 arm a cooldown while the provider still receives the same HttpError it receives today.

- [ ] **Step 3: Verify and commit**

~~~bash
bun vitest run tests/unit/services/commitChecks/http.test.ts
git add src/services/commitChecks/http.ts tests/unit/services/commitChecks/http.test.ts
git commit -m "feat(commit-checks): scope response metadata by API origin"
~~~

Expected: PASS; timeout, JSON parsing, non-2xx, and header-preservation behavior remains unchanged.

### Task 4: Wire every provider through the registry once at activation

**Files:**
- Modify: src/activation/repositoryMode.ts
- Modify: tests/integration/extension/view-providers.integration.test.ts
- Modify: tests/unit/services/commitChecks/coordinator.test.ts

- [ ] **Step 1: Add a failing extension integration matrix**

Use the existing real-gate harness, not a second extension bootstrap. Exercise these remotes with provider-valid mocked empty responses:

~~~ts
const providerCases = [
    { id: "gitlab", remote: "git@gitlab.example.test:group/repo.git" },
    { id: "bitbucket-cloud", remote: "git@bitbucket.org:workspace/repo.git" },
    { id: "bitbucket-server", remote: "ssh://git@bb.example.test:7999/PRJ/repo.git" },
] as const;
~~~

For each case, replay the existing visible-row demand above 300 HTTP starts and assert that the next request is blocked before transport. Add a second self-hosted GitLab/Data Center host assertion to prove no cross-host cooldown.

Run:

~~~bash
bun vitest run tests/integration/extension/view-providers.integration.test.ts
~~~

Expected: FAIL because the three non-GitHub providers still use bare httpGetJson.

- [ ] **Step 2: Replace GitHub-only fetch construction with one provider wrapper factory**

~~~ts
const commitCheckGates = new CommitChecksRequestGateRegistry({
    cooldownMessage: vscode.l10n.t(
        "Commit-check requests are temporarily paused due to rate limiting.",
    ),
});

const fetchFor = (providerId: ProviderId): FetchJson => {
    const fetchJson = createHttpGetJson((response) => {
        commitCheckGates.observeResponse(providerId, response);
    });
    return (url, headers) =>
        commitCheckGates.run(providerId, url, () => fetchJson(url, headers));
};

const commitChecksProviders: readonly CommitChecksProvider[] = [
    new GitHubProvider(fetchFor("github"), commitCheckSettings.ciCdPattern),
    new GitLabProvider(fetchFor("gitlab"), credentialStore, commitCheckSettings.ciCdPattern),
    new BitbucketCloudProvider(fetchFor("bitbucket-cloud"), credentialStore),
    new BitbucketServerProvider(fetchFor("bitbucket-server"), credentialStore),
];
~~~

Reset the registry only alongside the existing credential/settings cache-clear lifecycle. Do not reset it on hide, disposal, filter reset, graph refresh, or repository switch: those events must not erase a quota cooldown shared by the other live views.

- [ ] **Step 3: Add a coordinator regression**

Assert that an unavailable snapshot from a blocked gate is cached by the already-existing provider/repository key and that the same SHA from a different provider/repository still gets its own cache entry. Do not modify CommitChecksProvider or the GitLab/Bitbucket provider constructors; their FetchJson seam is sufficient.

- [ ] **Step 4: Verify and commit**

~~~bash
bun vitest run   tests/unit/services/commitChecks/coordinator.test.ts   tests/integration/extension/view-providers.integration.test.ts
git add   src/activation/repositoryMode.ts   tests/unit/services/commitChecks/coordinator.test.ts   tests/integration/extension/view-providers.integration.test.ts
git commit -m "fix(commit-checks): share safeguards across providers"
~~~

Expected: PASS. The integration matrix proves every provider is gated, each host is isolated, and no non-GitHub request starts once its gate cools down.

### Task 5: Localize the cooldown and correct public provider documentation

**Files:**
- Modify: docs/commit-checks/README.md
- Modify: docs/localization/localization_translation_review.csv through the existing import workflow
- Generated: localization catalog outputs produced by the import command

- [ ] **Step 1: Replace the stale rate-limit paragraph with the actual contract**

Add this table under Rate limits and caching:

~~~markdown
| Provider | Shared request scope | Proactive protection |
| --- | --- | --- |
| GitHub | api.github.com | quota reserve, reset/retry cooldown, four concurrent requests, 300 automatic requests/hour |
| GitLab | each configured API host | server-reported remaining/reset values, Retry-After, four concurrent requests, 300 automatic requests/hour |
| Bitbucket Cloud | api.bitbucket.org | X-RateLimit-NearLimit, Retry-After, four concurrent requests, 300 automatic requests/hour |
| Bitbucket Server/Data Center | each configured API host | 429/Retry-After, four concurrent requests, 300 automatic requests/hour |
~~~

State that the cache remains provider/repository scoped and a bare GitLab/Bitbucket 403 remains an authentication error rather than a quota signal.

- [ ] **Step 2: Import localization safely**

Run:

~~~bash
bun run l10n:sync
bun run l10n:translate -- --only-missing
bun run l10n:import
bun scripts/localization-csv.js validate
~~~

Expected: the generic cooldown string is present with no damaged placeholders/codicons. If l10n:sync or l10n:translate is unavailable, record that and run the existing l10n:import and l10n:validate commands instead. Do not hand-edit generated locale JSON.

- [ ] **Step 3: Verify docs/localization and commit**

~~~bash
bun run l10n:validate
bun run l10n:audit
git add docs/commit-checks/README.md docs/localization
git commit -m "docs(commit-checks): document provider rate-limit safeguards"
~~~

Expected: PASS; the generated diff contains only the new generic cooldown key and its catalog entries.

### Task 6: Final provider regression, release checks, and scope audit

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run focused provider coverage**

~~~bash
bun vitest run   tests/unit/services/commitChecks/requestGate.test.ts   tests/unit/services/commitChecks/http.test.ts   tests/unit/services/commitChecks/coordinator.test.ts   tests/unit/services/commitChecks/gitlabProvider.test.ts   tests/unit/services/commitChecks/bitbucketCloudProvider.test.ts   tests/unit/services/commitChecks/bitbucketServerProvider.test.ts   tests/integration/extension/view-providers.integration.test.ts
~~~

Expected: PASS. Provider pagination requests use the same gate and existing auth/state normalization remains unchanged.

- [ ] **Step 2: Run required quality gates**

~~~bash
bun run format:check
bun run lint
bun run architecture:check
bun run react-doctor
bun run typecheck
bun run build
bun run test
~~~

Expected: every command exits 0. Treat react-doctor output as existing telemetry unless this change adds a new finding.

- [ ] **Step 3: Run production/package checks and inspect scope**

~~~bash
bun run build:prod
bun run package
git diff --check
git status --short
~~~

Expected: production build and VSIX package pass; no whitespace errors; VSIX is ignored; only planned source, tests, docs, and localization files changed.

- [ ] **Step 4: Run GitNexus change analysis before the final commit**

Run detect_changes with scope compare and base_ref main. Stop if it reports HIGH or CRITICAL impact outside commit-check transport/gating, activation wiring, targeted tests, provider docs, or localization.

- [ ] **Step 5: Commit the completed feature**

~~~bash
git add   src/services/commitChecks/requestGate.ts   src/services/commitChecks/http.ts   src/activation/repositoryMode.ts   tests/unit/services/commitChecks   tests/integration/extension/view-providers.integration.test.ts   docs/commit-checks/README.md   docs/localization
git commit -m "feat(commit-checks): protect GitLab and Bitbucket quotas"
~~~

## Acceptance matrix

| Scenario | Required result |
| --- | --- |
| GitHub visible rows | Existing four-concurrent, 300/hour, reserve, and cooldown behavior is unchanged. |
| GitLab reports low remaining quota | All views sharing that API origin stop automatic HTTP until reset/retry time. |
| Bitbucket Cloud returns NearLimit true | All views stop automatic API requests for one hour unless a 429 supplies an explicit retry deadline. |
| Bitbucket Data Center returns 429 | That host pauses for Retry-After or 60 seconds; a separate Data Center host remains available. |
| GitLab/Bitbucket returns bare 403 | It stays authentication/unavailable and does not pause unrelated work. |
| Same SHA on different provider/repository | Existing provider/repository cache keys remain isolated. |
| Hidden/disabled/unmounted/filtered/stale graph | Existing demand teardown emits no new gate work. |
| Reload with persisted none result | Existing provider-keyed persistent cache semantics remain unchanged. |

## Plan self-review

- Coverage: Tasks 1–4 close the GitLab/Bitbucket gate gap without touching already-correct scheduling/cache layers; Task 5 aligns docs/localization; Task 6 proves release readiness.
- Scope: the registry is necessary because self-hosted provider quotas are origin-scoped. No provider API rewrite or new setting is introduced.
- Type consistency: HttpResponseMetadata.url is produced by createHttpGetJson, registry methods accept existing ProviderId/FetchJson values, and provider constructors remain unchanged.
