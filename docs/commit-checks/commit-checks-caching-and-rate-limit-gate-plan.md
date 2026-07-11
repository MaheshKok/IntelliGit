# Commit Checks — Shared Cache and Global Rate-Limit Gate — Design Plan

Reduce GitHub commit-check API bursts and duplicate calls across the commit
graph, sidebar graph, and undocked views without changing provider output
semantics. The primary fix is a shared runtime service plus a global request
gate; a persistent cache follows only after that.

Motivation: with many repositories open, users hit `HTTP 403: API rate limit
exceeded`. A per-hash cache already exists, so caching alone is not the fix. The
root cause is that the cache, the in-flight de-dupe map, and the rate-limit
breaker are all per-view-instance and in-memory, while GitHub's rate limit is
global to the user token.

No emojis. Target VS Code extension host (Node), TypeScript strict, React
webview. Use `bun` for all tooling, never `npx`. Each phase is a self-contained
unit of work with files, tests, and acceptance criteria.

---

## A. Verified current state (read before planning)

Fetch flow: the webview graph renders commits; for each commit worth fetching it
posts a request; the view calls `coordinator.getChecks(hash)`; the GitHub
provider makes two REST calls (check-runs and statuses) per commit.

Per-view coordinators (each builds its own providers and cache):

- `src/views/CommitGraphViewProvider.ts:126` — `new CommitChecksCoordinator(...)`
  with `new GitHubProvider(httpGetJson, settings?.ciCdPattern)`.
- The sidebar graph is a second `CommitGraphViewProvider`, so it constructs a
  second coordinator and a second GitHub provider.
- `src/views/UndockedViewProvider.ts:240` — a third coordinator and provider.

Coordinator caching and de-dupe are per instance:

- `src/services/commitChecks/coordinator.ts:54` — `cache = new Map<hash, entry>()`
  and `inflight = new Map<hash, promise>()`.
- Terminal snapshots cached in memory forever; non-terminal (`pending`, `none`,
  `unavailable`) cached for `DEFAULT_COMMIT_CHECKS_TTL_MS` (15s). See
  `coordinator.ts:116` (`isFresh`).
- Cache is keyed by the bare commit hash. Provider resolution happens on a cache
  miss inside `fetchFresh` (`coordinator.ts:128`), so cache hits do no Git work.

Rate-limit handling is per provider instance:

- `src/services/commitChecks/githubProvider.ts:82` — `rateLimitedUntil` /
  `rateLimitError` fields, `rememberRateLimit` (`:159`), and the header parsing
  in `readRateLimitUntil` (`:167`) honoring `retry-after`,
  `x-ratelimit-remaining`, `x-ratelimit-reset`, and status `403` / `429`.
- The provider short-circuits to `unavailable` while cooling down
  (`githubProvider.ts:124`).

Per-commit cost: `githubProvider.ts:138` runs check-runs and statuses in
parallel — two API calls per commit, so N visible commits = 2N calls.

HTTP boundary and error metadata:

- `src/services/commitChecks/http.ts` — `httpGetJson` (15s timeout) rejects with
  `HttpError(statusCode, message, headers)` on non-2xx, preserving headers for
  backoff.

Cache clearing today:

- `src/activation/repositoryMode.ts:833` — `refreshCommitCheckBadges` clears all
  three graph caches, fired only on sign-in/sign-out (credential change).
- `src/views/UndockedViewProvider.ts:393` — `resetRepositoryScopedState` calls
  `this.commitChecks.clear()` on the undocked view's own repository switch.
- Docked graphs do not clear on repository switch.

Provider references are heterogeneous (this matters for the cache key):

- `src/services/commitChecks/types.ts:18` — `ProviderRepoRef` guarantees only
  `host`.
- GitHub: `{ host, owner, repo }` (`githubProvider.ts:20`).
- GitLab: `{ host, owner, repo }`, where `owner` may be a group path
  (`gitlabProvider.ts:22`).
- Bitbucket Cloud: `{ host, workspace, repo }` (`bitbucketCloudProvider.ts:24`).
- Bitbucket Server: project/repo shape (`bitbucketServerProvider.ts`).

Settings shape:

- `src/services/commitChecks/settingsConfig.ts:29` — `CommitChecksSettings` =
  `{ enabled, providers, ciCdPattern?, ciCdFilterInvalid? }`. Only `ciCdPattern`
  changes the content of a fetched snapshot (the CI/CD name filter applied in
  `githubProvider.ts:68` via `isCiCdCheckItem`). `enabled` and `providers` gate
  whether a fetch happens at all, not the content of a fetched result. Settings
  are read once at activation (`repositoryMode.ts:106`); changing them requires a
  window reload.

## B. Root cause (why a cache alone does not fix the 403)

GitHub's rate limit is global to the user token, but every safeguard is
per-view-instance and in-memory. Four amplifiers:

1. Per-view coordinators: the docked graph, the sidebar graph, and the undocked
   view each fetch the same repository's same commit SHAs through separate
   caches, so the same commit is fetched two or three times.
2. In-memory only: the cache and the breaker die on window reload or extension
   restart, so every reload re-fetches all visible commits.
3. No global concurrency cap: M visible commits produce up to 2M concurrent
   HTTPS calls, which trips GitHub's secondary (abuse) rate limit — a 403 with
   `retry-after` — well before the 5000/hour primary budget is exhausted.
4. Per-instance breaker: a 403 learned by one view does not stop the other two.

A 50-commit graph across two docked views on reload is roughly 200 concurrent
requests. The concurrency cap and a single shared cooldown are what actually stop
the 403; persistence reduces steady-state volume.

## C. Target architecture

Split "which repository" (a per-view concern) from "cache, de-dupe, and gate"
(a shared concern). The shared layer is the single source of truth per user
token; the per-view layer stays repository-scoped.

```
 commitGraph   sidebarGraph   undocked
      \             |            /
       \            |           /   getChecks(hash)  (unchanged view API)
        v           v          v
   per-view Coordinator (thin):
     - resolve provider + ref (MEMOIZED per repo root)
     - build key = provider.keyFor(ref) + "@" + sha + ":" + settingsFp
        |
        v   getOrFetch(key, () => provider.getChecks(ref, sha))
   CommitChecksService  (ONE shared instance):
     - L1 Map(key -> entry) + in-flight Map(key -> promise)
     - TTL rules unchanged; L1 LRU-capped
     - (P2) persistent terminal cache
        |
        v   fetch on miss
   GitHubRequestGate  (ONE shared instance):
     - semaphore: max 4 concurrent
     - global cooldown: one rateLimitedUntil
        |
        v
     GitHub REST
```

- The shared service owns L1 cache, in-flight de-dupe, and (P2) persistence,
  keyed by the composite key. Two docked views resolve the same repository to the
  same key, so the same commit is fetched once.
- The shared gate wraps the GitHub `FetchJson`; it owns the concurrency cap and a
  single cooldown honored by all views.
- A thin per-view coordinator keeps the existing `getChecks(hash)` view API
  (near-zero view churn) and owns repository resolution and key building.

## D. Three gaps closed

### Gap 1 — Repo-scoped key is mandatory once the cache is shared

Keying by bare SHA is correct today only because each coordinator serves one
repository at a time. The shared service serves multiple repositories at once
(the docked active repository plus the undocked view's independently selected
repository). A SHA shared across repositories (a fork or a cherry-pick) would
then serve repository A's checks for repository B. Unifying the cache requires
the composite key for correctness, not merely for the persistent cache.

Key format:

```
${provider.keyFor(ref)}@${sha}:${settingsFp}
# example:  github:github.com:owner/repo@abc123:-
```

Resolution-before-lookup subtlety: a repo-scoped key must be computed before the
cache lookup, and provider resolution costs Git calls (`getRemotes` +
`getRemoteUrl`). Doing that per commit would turn cache hits into Git work.
Resolution is therefore memoized per repository root in the coordinator; remotes
change only on repository switch (a new root yields a new memo entry) or a rare
runtime remote edit (cleared by a manual refresh). Fifty commits share one
resolution; cache hits stay Git-free.

### Gap 2 — Provider owns its cache key

`ProviderRepoRef` guarantees only `host`, and refs are heterogeneous
(GitHub/GitLab use `owner/repo`, Bitbucket uses `workspace/repo`), so the service
cannot derive a key generically. Extend the provider interface:

```ts
// src/services/commitChecks/types.ts
export interface CommitChecksProvider {
    readonly id: ProviderId;
    match(remoteUrl: string, hostMap: HostMap): ProviderRepoRef | null;
    keyFor(ref: ProviderRepoRef): string; // NEW: stable repo identity, lowercased
    getChecks(ref: ProviderRepoRef, hash: string): Promise<CommitChecksSnapshot>;
}
```

Per-provider implementations (a few lines each):

| Provider         | `keyFor(ref)`                                              |
| ---------------- | --------------------------------------------------------- |
| GitHub           | `github:${host}:${owner}/${repo}` (lowercased)            |
| GitLab           | `gitlab:${host}:${owner}/${repo}` (owner may be a group)  |
| Bitbucket Cloud  | `bitbucket-cloud:${host}:${workspace}/${repo}`            |
| Bitbucket Server | `bitbucket-server:${host}:${project}/${repo}`             |

Settings fingerprint: the only content-affecting setting is the CI/CD filter, so

```ts
const settingsFp = settings.ciCdPattern ? settings.ciCdPattern.source : "-";
```

Caveat: settings are read once at activation and only change on reload (which
already wipes L1), so `settingsFp` is a no-op in P1 and is load-bearing only in
P2's cross-session cache. It is included now so P2 needs no key migration.

### Gap 3 — Stop clearing on repository switch

With repo-scoped keys there is no collision reason to clear on switch, and
retaining entries makes switch-back instant — the exact 30-repository switching
workload that motivated this work.

| Trigger                                                    | Today          | Revised                                                                    |
| --------------------------------------------------------- | -------------- | -------------------------------------------------------------------------- |
| Credential change (`repositoryMode.ts:833`)               | clears         | keep (sign-in reveals private-repo checks previously reported as `none`)   |
| Undocked repo switch (`UndockedViewProvider.ts:393`)      | clears         | remove — a different repository uses different keys                        |
| Docked repo switch                                        | no clear       | unchanged                                                                  |
| Global cooldown (gate)                                    | n/a            | never cleared by cache clears; only its own timer                          |

Consequence: L1 now retains entries across every visited repository in a session,
so add an LRU cap to L1 (for example 1000 entries). Today's L1 is unbounded
(terminal cached forever) — a latent leak that cross-repository retention would
grow faster; the cap closes it. Audit all `commitChecks.clear()` call sites in
`UndockedViewProvider.ts` and keep only credential and dispose paths.

## E. The gate — a dedicated semaphore, not `mapWithConcurrency`

`mapWithConcurrency` (in `src/utils/concurrency.ts`) is batch-shaped: it takes a
finite array and resolves when the batch drains. The gate is long-lived, serving
a stream of independent view requests over time. Build a small queue:

```ts
// src/services/commitChecks/requestGate.ts
export class GitHubRequestGate {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    private cooldownUntil = 0;
    private cooldownError = "";

    constructor(
        private readonly limit: number, // 4; local constant, no user setting yet
        private readonly now: () => number = Date.now,
    ) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.now() < this.cooldownUntil) {
            throw new HttpError(403, this.cooldownError, {});
        }
        await this.acquire();
        try {
            return await task();
        } catch (err) {
            this.rememberCooldown(err); // moved from GitHubProvider
            throw err;
        } finally {
            this.release();
        }
    }
    // acquire/release drain waiters; rememberCooldown reuses readRateLimitUntil()
}
```

Seam (wrap the GitHub `FetchJson`, keeping the provider mostly unchanged):

```ts
const gate = new GitHubRequestGate(4);
const githubFetch: FetchJson = (url, headers) => gate.run(() => httpGetJson(url, headers));
new GitHubProvider(githubFetch, settings.ciCdPattern);
```

Delete the provider's own `rateLimitedUntil` short-circuit
(`githubProvider.ts:124`); the gate owns cooldown globally. Move
`readRateLimitUntil` and `readRetryAfter` into the gate. Cooldown rules are
unchanged: `retry-after` wins; else `x-ratelimit-remaining === "0"` with a future
`x-ratelimit-reset`; else 60s for a bare 429; else no global cooldown.

Thundering-herd note: when cooldown expires, TTL-expired non-terminal entries
re-fetch together; the concurrency cap throttles that automatically.

## F. Phase 1 — Shared service and gate

Deliverables:

- New `src/services/commitChecks/service.ts` — shared cache and de-dupe;
  `getOrFetch(key, fetch)`; preserves current TTL rules; L1 LRU cap.
- New `src/services/commitChecks/requestGate.ts` — semaphore plus global cooldown.
- Change `types.ts` — add `keyFor` to `CommitChecksProvider`.
- Change all four providers — implement `keyFor`; GitHub loses its own breaker.
- Thin `coordinator.ts` — resolve provider and ref (memoized per root), build the
  key, delegate to the shared service.
- Change `repositoryMode.ts` — build one service, one gate, and one shared GitHub
  provider after `hostMap`, `commitChecksSettings`, `credentialStore`, and
  `gitOps` are known; inject the same service into both `CommitGraphViewProvider`
  instances and the `UndockedViewProvider` (prefer the options object, the
  constructors are already large).
- Remove the undocked repository-switch cache clear.

Views keep calling `this.commitChecks.getChecks(hash)`; only the injected
instance changes.

Preserve existing behavior in P1: terminal snapshots cached in memory
(effectively forever, subject to the LRU cap); `pending` / `none` / `unavailable`
cached for the 15s TTL. No persistence yet.

Tests (focused; no framework build-out):

1. De-dupe — two concurrent `getChecks` for the same key call the provider once;
   both callers receive the same snapshot.
2. Cross-repository keys — the same SHA with two different repository refs yields
   two fetches and no cross-serving. (Guards Gap 1.)
3. Gate concurrency — start 10 tasks against a gate of limit 4; assert active
   never exceeds 4.
4. Gate cooldown — first task rejects with `HttpError(403)` carrying
   `x-ratelimit-remaining: "0"` and a future `x-ratelimit-reset`; the next task
   does not hit HTTP; the service surfaces `unavailable`.
5. Cooldown is global — a cooldown learned via one caller blocks a fetch
   requested via another caller sharing the same gate.
6. TTL preserved — terminal cached; `pending` re-fetches after TTL; no provider
   match returns `none`; a disabled provider returns `none`.
7. Settings fingerprint — a different `ciCdPattern` produces a distinct key.
   (Guards Gap 2.)
8. No clear on repository switch — switch away and back; served from cache with
   zero new fetches. (Guards Gap 3.)

Gate before merge: focused tests, then `format:check`, `lint`, `typecheck`,
`build`, and full `test`.

Expected result after P1 (50 commits; graph + sidebar + undocked):

- One shared in-memory cache; one in-flight promise per key; one GitHub gate.
- At most 4 concurrent GitHub HTTP calls; one cooldown blocks all views.
- The same SHA requested by multiple views is fetched once.

## G. Phase 2 — Persistent terminal cache (after P1 lands)

- New `src/services/commitChecks/persistentCache.ts` over VS Code `globalState`,
  single namespace key `intelligit.commitChecks.cache.v1`.
- Persist terminal states only (`success`, `failure`, `skipped`, `neutral`,
  `cancelled`, `timed_out`, `action_required`, and `unknown` if treated as
  terminal). Never persist `pending`, `none`, or `unavailable`.
- Entry shape: `{ key, snapshot, fetchedAt, lastAccessedAt, schemaVersion }`.
- Eviction: max 2000 entries; max age 24h; evict oldest by `lastAccessedAt`. The
  24h cap bounds the risk that a CI rerun mutated a completed commit's checks; a
  manual refresh can bypass.
- Lookup order: L1 -> L2 -> provider fetch through the gate. On an L2 hit, return
  immediately, promote to L1, and update `lastAccessedAt`. On a fetch, write
  terminal snapshots to L2 and all snapshots to L1 per the P1 TTL rules.
- Manual refresh bypasses L1 and L2 for the requested key, then repopulates.
- If entries outgrow `globalState` (a small key-value store), move L2 to a JSON
  file under `context.globalStorageUri`.

Tests: terminal snapshot survives a new service instance; non-terminal states are
not persisted; an expired terminal entry is ignored; the LRU cap evicts the
oldest; a settings-fingerprint change misses the old cache.

## H. Phase 3 — Fetch-volume reduction (later)

- Fetch visible rows first; background-fetch the next page only when the gate has
  capacity; stop background fetch when the remaining GitHub quota is low.
- Possible protocol change:
  `requestCommitChecks({ hashes, priority: "visible" | "background" })`.
- GraphQL is the real ceiling: one query can return check state for many commits,
  versus REST's two calls per commit. It is the eventual volume fix; the REST gate
  is a throttle on an inherently chatty API. Do not start P3 before P1.

## I. Risks

- Terminal is not strictly immutable — a CI rerun can change a completed commit's
  checks. This is already the current in-memory assumption; P2 bounds it with the
  24h age cap and the manual refresh bypass.
- `globalState` is a small key-value store, not a database — bounded by the LRU
  cap, the age cap, and a `schemaVersion` namespace wipe; the file fallback covers
  growth.
- The gate adds bounded queue latency — mitigated by the concurrency cap and, in
  P3, by fetching visible rows first.

## J. Deliberate non-goals for P1

- No persistent cache.
- No GraphQL batching.
- No provider-wide redesign.
- No user setting for concurrency unless needed.
- No viewport protocol changes.
- No GitLab or Bitbucket gate unless tests or telemetry show they need one.

## K. Implementation order

1. Add `CommitChecksService` with the current coordinator caching behavior.
2. Move the in-memory cache and in-flight map into the service; add the L1 LRU cap.
3. Add `GitHubRequestGate` and the gated `FetchJson` wrapper; move cooldown out of
   the GitHub provider.
4. Add `keyFor` to the provider interface and each provider; compose the composite
   key (with `settingsFp`) in the thin coordinator.
5. Wire one shared service, gate, and GitHub provider in `repositoryMode.ts`;
   inject into the graph, sidebar, and undocked views.
6. Remove the undocked repository-switch cache clear; keep credential and dispose
   clears.
7. Port and update coordinator tests to the service; add the focused gate tests.
8. Run focused tests, then `format:check`, `lint`, `typecheck`, `build`, and full
   `test`.
