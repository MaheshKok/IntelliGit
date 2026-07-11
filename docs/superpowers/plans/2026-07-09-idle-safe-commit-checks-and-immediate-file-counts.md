# Idle-Safe Commit Checks and Immediate File Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop idle IntelliGit views from exhausting the GitHub REST quota, fetch commit checks only for the exact visible viewport with bounded retries and persistent negative caching, and restore last-known multi-repository changed-file counts immediately before Git refresh completes.

**Architecture:** Keep the existing shared `CommitChecksService`, provider coordinators, and `GitHubRequestGate`. Replace per-row fire-and-forget requests with one replaceable viewport-demand message per graph surface, process each surface's demand sequentially with a generation guard, apply state-specific cache/retry rules, and make the shared GitHub gate observe successful rate-limit headers before allowing more background calls. Store only per-repository changed-file counts in `workspaceState`, render them synchronously, then reconcile through the existing bounded `git status` scans.

**Tech Stack:** VS Code extension host, TypeScript strict mode, React webviews, Vitest, Bun, VS Code `Memento`, Node `https`, existing Git providers and extension-host integration harnesses.

---

## 1. Execution Contract

This document is a delta plan. Shared caching, in-flight deduplication, terminal persistence, visible-row message batching, and the global GitHub cooldown gate already exist on the target branch. Do not reimplement those phases from the older design document.

At plan creation, repository state was:

```text
branch: codex/commit-checks-persistent-cache
ahead of origin/main: 4 commits
modified:
  src/views/CommitGraphViewProvider.ts
  src/views/UndockedViewProvider.ts
  tests/integration/extension/view-providers.integration.test.ts
untracked:
  docs/commit-checks/commit-checks-caching-and-rate-limit-gate-plan.md
  docs/superpowers/
```

The three modified source/test files contain current multi-repository 404 protection:

- loaded commit hashes are scoped to the current repository generation;
- unpushed commits return `none` without calling GitHub;
- stale graph loads and stale check requests are discarded after repository reset.

Treat those edits as user-owned baseline work. Never reset, overwrite, or silently drop them. Re-read the live diff before implementation because branch state may have changed since this plan was written.

### Mandatory tool startup

- [ ] Run Serena `initial_instructions`.
- [ ] Confirm codebase-memory index status for the absolute repository path.
- [ ] Use codebase-memory `search_graph` and `get_code_snippet` before text search.
- [ ] Before editing each existing symbol, run GitNexus upstream impact analysis.
- [ ] If impact is HIGH or CRITICAL, stop and report the blast radius before editing.
- [ ] Use `rtk`-prefixed shell commands and Bun. Do not use `npx`.
- [ ] Before every commit, run GitNexus `detect_changes` against `main`.

### Required behavior

1. Opening a workspace with 30 repositories must not fetch commit checks for 29 inactive repositories.
2. A graph surface may request only commits intersecting its exact viewport. Render overscan must not become network overscan.
3. A newer viewport or repository generation replaces older queued demand. At most one already-started commit may complete after replacement.
4. `pending`, `none`, and `unavailable` must never poll forever.
5. A `none` snapshot is persisted for one hour. Only the current branch HEAD may bypass that cache automatically, at most twice.
6. A `pending` snapshot may refresh at most three times while still visible.
7. `unavailable` receives no timer-driven retry.
8. Successful GitHub response headers must proactively stop background calls before remaining quota reaches zero.
9. Existing primary/secondary cooldown handling remains global across graph, sidebar, and undocked surfaces.
10. Last-known changed-file counts appear synchronously on activation and are then replaced by fresh Git status results.

### Explicit non-goals

- Do not implement GraphQL in the required fix.
- Do not implement ETag storage in the required fix.
- Do not add dependencies.
- Do not redesign GitLab or Bitbucket providers.
- Do not persist `pending` or `unavailable` snapshots.
- Do not persist changed file paths, branch names, or file metadata; persist counts only.
- Do not add user settings for retry, TTL, concurrency, or budget constants yet.
- Do not bypass the quota reserve from the existing manual badge-refresh command.
- Do not add a second scheduler service. Per-view sequential demand plus the existing shared cache/gate is sufficient.
- Do not bump the version until all automated and manual acceptance gates pass.
- Do not run `bun run publish`.

## 2. Verified Current Defects

### 2.1 Idle request amplification

`src/webviews/react/CommitList.tsx` currently:

- defines the network-visible set using the render range with 8 rows of overscan above and below;
- sends one request callback per row;
- retries `pending` and `unavailable` every 15 seconds without a limit;
- retries `none` six times;
- keeps retry state in the webview, while host cache state expires on the same 15-second cadence.

`src/services/commitChecks/githubProvider.ts` makes two REST calls for every provider fetch:

```text
GET /repos/{owner}/{repo}/commits/{sha}/check-runs
GET /repos/{owner}/{repo}/commits/{sha}/statuses
```

Thirty-six requested rows returning `none` can therefore consume:

```text
36 rows * (1 initial + 6 retries) * 2 endpoints = 504 REST requests
```

The current tick batcher reduces webview messages, not GitHub calls.

### 2.2 Cache gaps

`src/services/commitChecks/persistentCache.ts` persists terminal states only. `none`, `pending`, and `unavailable` disappear on reload.

`src/services/commitChecks/service.ts` uses one TTL for all non-terminal states. It cannot express:

- short pending freshness;
- long negative `none` freshness;
- no timer retry for `unavailable`;
- a forced current-HEAD retry that bypasses the one-hour `none` cache.

### 2.3 Reactive-only quota gate

`src/services/commitChecks/requestGate.ts` learns cooldown only from thrown `403`/`429` errors. `src/services/commitChecks/http.ts` discards successful response headers, so the gate cannot see `x-ratelimit-remaining` until failure.

Authenticated GitHub REST requests made on behalf of one user share that user's primary budget. IntelliGit may begin with far fewer than 5,000 calls remaining because another editor, CLI, OAuth app, GitHub App, or token already used part of it.

### 2.4 Delayed file count

`src/activation/repositoryMode.ts` explicitly sets the native file-count badge to zero before subscribing to panel updates. `CommitPanelViewProvider` then runs asynchronous `git status` scans. Native Git-style stale-while-revalidate behavior is absent.

## 3. Target Request and Cache State Machines

### 3.1 Webview demand states

```text
missing        -> request immediately when exact-visible
terminal       -> no automatic request
none/non-HEAD  -> no automatic retry
none/HEAD      -> force retry after 30s, then 60s, then stop
pending        -> force retry after 30s, 60s, 120s, then stop
unavailable    -> no timer retry
hidden         -> send empty demand and cancel queued work
```

The current branch HEAD is the local branch where `branch.isCurrent && !branch.isRemote`; use its full `hash`. Do not assume `commits[0]` is current HEAD because an all-branches graph can place another branch first.

### 3.2 Host cache states

```text
terminal       L1 until LRU eviction; L2 for 24h
none           L1 and L2 for 1h
pending        L1 for 30s; never L2
unavailable    L1 for 15m; never L2; no UI timer retry
```

Forced requests skip L1 and L2 but still join an existing in-flight request for the same composite key.

### 3.3 GitHub gate policy

```text
max concurrent HTTP calls:              4
automatic calls per rolling hour:        300
primary reserve:                         max(100, ceil(limit * 0.10))
primary reset source:                    x-ratelimit-reset
secondary reset source:                  retry-after, existing fallback rules
```

The 300-call rolling cap is an extension-owned backstop, not a user setting. Tune it only if measured normal usage cannot fill one viewport and tests demonstrate the failure.

### 3.4 Changed-file cache

```ts
interface StoredChangedFileCount {
    root: string;
    includeIgnored: boolean;
    count: number;
    updatedAt: number;
}

interface StoredChangedFileCountPayload {
    schemaVersion: 1;
    entries: StoredChangedFileCount[];
}
```

Rules:

- storage: `workspaceState` key `intelligit.changedFileCounts.v1`;
- maximum entries: 100;
- maximum age: 30 days;
- count may be zero and zero must not be treated as missing;
- invalid, negative, fractional, non-finite, or stale values are ignored;
- fresh status results replace stale values;
- failed scans preserve stale values;
- writes are serialized and skipped when the value is unchanged.

## 4. File Map

### Commit-check request flow

- Modify `src/webviews/react/CommitList.tsx`: separate render overscan from exact network range; publish replacement demand; enforce retry budgets.
- Modify `src/webviews/react/commit-list/checksRefresh.ts`: hold retry-delay constants and pure retry selection.
- Delete `src/webviews/react/commit-list/useCommitCheckRequestBatcher.ts`: tick batching is obsolete once `CommitList` sends one array.
- Modify `src/webviews/react/CommitGraphPanel.tsx`: publish array demand and current branch HEAD.
- Modify `src/webviews/react/NativeCommitGraph.tsx`: same compact-graph wiring.
- Modify `src/webviews/react/undocked/useUndockedActions.ts`: same undocked wiring.
- Modify `src/webviews/react/undocked/UndockedLayout.tsx`: array callback and current branch HEAD prop.
- Modify `src/webviews/react/UndockedApp.tsx`: pass current branch HEAD into layout.
- Modify `src/webviews/protocol/commitGraphTypes.ts`: replace single/hash union with one viewport-demand message.
- Modify `src/webviews/protocol/undockedMessages.ts`: mirror the same message.
- Modify `src/views/CommitGraphViewProvider.ts`: validate, replace, serialize, and cancel demand while preserving loaded/unpushed guards.
- Modify `src/views/UndockedViewProvider.ts`: same behavior for independent undocked repository state.

### Cache and quota

- Modify `src/services/commitChecks/service.ts`: state-specific L1 TTL and force bypass.
- Modify `src/services/commitChecks/persistentCache.ts`: persist `none` with one-hour age while retaining 24-hour terminal age.
- Modify `src/services/commitChecks/coordinator.ts`: forward force requests.
- Modify `src/services/commitChecks/http.ts`: expose successful response metadata through a small observer factory.
- Modify `src/services/commitChecks/requestGate.ts`: track successful quota headers, rolling request budget, reserve, and auth reset.
- Modify `src/activation/repositoryMode.ts`: wire observed GitHub HTTP, reset gate only on auth-session change, and keep manual refresh subject to budget.

### Changed-file startup state

- Modify `src/views/commitPanelRepositoryRuntime.ts`: store last-known count independently from `files`.
- Modify `src/views/CommitPanelViewProvider.ts`: validate/hydrate/persist counts and expose synchronous aggregate count.
- Modify `src/activation/repositoryMode.ts`: initialize badge from provider cache and remove switch-time zero reset.

### Tests and release metadata

- Modify `tests/webview/unit/low-coverage-components.test.tsx`.
- Delete `tests/webview/unit/commitCheckRequestBatcher.test.tsx`.
- Modify `tests/unit/services/commitChecks/service.test.ts`.
- Modify `tests/unit/services/commitChecks/persistentCache.test.ts`.
- Modify `tests/unit/services/commitChecks/http.test.ts`.
- Modify `tests/unit/services/commitChecks/requestGate.test.ts`.
- Modify `tests/unit/services/commitChecks/coordinator.test.ts`.
- Modify `tests/integration/extension/view-providers.integration.test.ts`.
- Modify `CHANGELOG.md` only after acceptance.
- Modify `package.json` to `0.17.1` only after acceptance.

## 5. Task 0: Preserve Baseline and Prove Existing Tests

**Files:** No edits.

- [ ] **Step 1: Inspect branch and user changes**

Run:

```bash
rtk git status --short --branch
rtk git diff --stat
rtk git diff -- src/views/CommitGraphViewProvider.ts src/views/UndockedViewProvider.ts tests/integration/extension/view-providers.integration.test.ts
```

Expected: no destructive operation; current hash-scope/unpushed guards remain visible in the diff or are already committed.

- [ ] **Step 2: Run current focused baseline**

```bash
rtk bun vitest run \
  tests/unit/services/commitChecks/service.test.ts \
  tests/unit/services/commitChecks/persistentCache.test.ts \
  tests/unit/services/commitChecks/requestGate.test.ts \
  tests/unit/services/commitChecks/http.test.ts \
  tests/webview/unit/low-coverage-components.test.tsx \
  tests/webview/unit/commitCheckRequestBatcher.test.tsx \
  tests/integration/extension/view-providers.integration.test.ts
```

Expected: PASS. If baseline fails, stop. Record failures as pre-existing and fix them separately before following this plan.

- [ ] **Step 3: Confirm target symbols and impact**

Run GitNexus upstream impact for:

```text
CommitList
CommitGraphViewProvider.sendCommitChecksRequest
UndockedViewProvider.sendCommitChecksRequest
CommitChecksService.getOrFetch
GitHubRequestGate.run
CommitPanelViewProvider.countChangedFiles
CommitPanelViewProvider.updateAggregateChangedFileCount
```

Expected: blast radius understood before edits. Do not commit in this task.

## 6. Task 1: Replace Per-Row Batching with Exact Viewport Demand

**Files:**

- Modify: `src/webviews/react/CommitList.tsx:48-69,202-262`
- Modify: `src/webviews/protocol/commitGraphTypes.ts:166-181`
- Modify: `src/webviews/protocol/undockedMessages.ts:142-157`
- Modify: `src/webviews/react/CommitGraphPanel.tsx:390-407`
- Modify: `src/webviews/react/NativeCommitGraph.tsx:266-282`
- Modify: `src/webviews/react/undocked/useUndockedActions.ts:37-49,77-79,138-146`
- Modify: `src/webviews/react/undocked/UndockedLayout.tsx:85-95,309-318`
- Modify: `src/webviews/react/UndockedApp.tsx`
- Delete: `src/webviews/react/commit-list/useCommitCheckRequestBatcher.ts`
- Test: `tests/webview/unit/low-coverage-components.test.tsx`
- Delete: `tests/webview/unit/commitCheckRequestBatcher.test.tsx`

- [ ] **Step 1: Add a failing exact-range test**

Add a `CommitList` test that creates 30 commits, exposes a viewport of exactly 3 rows, scrolls to row 10, and expects one array containing rows 10-12 only. The callback type is `(hashes: string[], force?: boolean) => void`.

Core assertion:

```tsx
expect(onRequestCommitChecks).toHaveBeenLastCalledWith(
    [commits[10].hash, commits[11].hash, commits[12].hash],
    false,
);
expect(onRequestCommitChecks.mock.calls.flatMap(([hashes]) => hashes)).not.toContain(
    commits[9].hash,
);
expect(onRequestCommitChecks.mock.calls.flatMap(([hashes]) => hashes)).not.toContain(
    commits[13].hash,
);
```

Run:

```bash
rtk bun vitest run tests/webview/unit/low-coverage-components.test.tsx
```

Expected before implementation: FAIL because the callback receives individual hashes and includes render overscan.

- [ ] **Step 2: Replace the protocol union**

Use one message shape in both protocol files:

```ts
| {
      /** Replaces this graph surface's current exact-viewport commit-check demand. */
      type: "requestVisibleCommitChecks";
      /** Deduplicated full Git object IDs intersecting the exact viewport. */
      hashes: string[];
      /** Bypasses fresh snapshots for a bounded pending/current-HEAD retry. */
      force?: boolean;
  }
```

Remove the old `requestCommitChecks` single-hash and optional-array variants. Host and webview are bundled together, so no compatibility union is needed.

- [ ] **Step 3: Separate render and request ranges**

Keep the existing overscanned range for `CommitListRows`. Add an exact request range:

```ts
const requestRange = useMemo(() => {
    if (commits.length === 0) return { start: 0, end: 0 };
    const effectiveHeight = Math.max(ROW_HEIGHT, viewportHeight);
    return {
        start: Math.max(0, Math.floor(scrollTop / ROW_HEIGHT)),
        end: Math.min(commits.length, Math.ceil((scrollTop + effectiveHeight) / ROW_HEIGHT)),
    };
}, [commits.length, scrollTop, viewportHeight]);

const requestedCommitHashes = useMemo(
    () => commits.slice(requestRange.start, requestRange.end).map((commit) => commit.hash),
    [commits, requestRange.end, requestRange.start],
);
```

Rename the old `visibleCommits` variable to `renderedCommits` so future code cannot confuse rendering overscan with network demand.

- [ ] **Step 4: Publish one replacement message**

Change `CommitList` prop:

```ts
onRequestCommitChecks?: (hashes: string[], force?: boolean) => void;
```

Send the complete exact range whenever it changes. Send an empty array when the document is hidden or the component unmounts so host work is cancelled:

```ts
useEffect(() => {
    if (!onRequestCommitChecks) return;
    const publish = (): void => {
        onRequestCommitChecks(
            document.visibilityState === "hidden" ? [] : requestedCommitHashes,
            false,
        );
    };
    publish();
    document.addEventListener("visibilitychange", publish);
    return () => {
        document.removeEventListener("visibilitychange", publish);
        onRequestCommitChecks([], false);
    };
}, [onRequestCommitChecks, requestedCommitHashes]);
```

- [ ] **Step 5: Remove the tick batcher**

Delete `useCommitCheckRequestBatcher.ts` and its unit test. Each parent callback now posts one already-batched message:

```ts
const handleRequestCommitChecks = useCallback(
    (hashes: string[], force = false) => {
        for (const hash of hashes) {
            dispatch({ type: "markCommitChecksLoading", hash });
        }
        vscode.postMessage({ type: "requestVisibleCommitChecks", hashes, force });
    },
    [vscode],
);
```

Use the equivalent `graphDispatch` implementation in `useUndockedActions`. Update callback types through `UndockedLayout` and `UndockedApp`.

- [ ] **Step 6: Run focused webview tests**

```bash
rtk bun vitest run \
  tests/webview/unit/low-coverage-components.test.tsx \
  tests/integration/webviews/commitChecksEnabled-gating.integration.test.tsx \
  tests/integration/webviews/react-context.integration.test.tsx
```

Expected: PASS; no source import of `useCommitCheckRequestBatcher` remains.

- [ ] **Step 7: Commit**

Before commit, run GitNexus `detect_changes({scope: "compare", base_ref: "main"})`.

```bash
rtk git add \
  src/webviews/protocol/commitGraphTypes.ts \
  src/webviews/protocol/undockedMessages.ts \
  src/webviews/react/CommitList.tsx \
  src/webviews/react/CommitGraphPanel.tsx \
  src/webviews/react/NativeCommitGraph.tsx \
  src/webviews/react/UndockedApp.tsx \
  src/webviews/react/undocked/useUndockedActions.ts \
  src/webviews/react/undocked/UndockedLayout.tsx \
  src/webviews/react/commit-list/useCommitCheckRequestBatcher.ts \
  tests/webview/unit/commitCheckRequestBatcher.test.tsx \
  tests/webview/unit/low-coverage-components.test.tsx
rtk git commit -m "fix(commit-checks): request exact viewport batches"
```

## 7. Task 2: Make Host Demand Replaceable and Stale-Safe

**Files:**

- Modify: `src/views/CommitGraphViewProvider.ts`
- Modify: `src/views/UndockedViewProvider.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Write stale-demand regression tests**

For each provider, use a deferred first `providerGetChecks` result:

```ts
let resolveFirst!: (snapshot: CommitChecksSnapshot) => void;
providerGetChecks.mockImplementationOnce(
    () =>
        new Promise((resolve) => {
            resolveFirst = resolve;
        }),
);

const firstDemand = webview.send({
    type: "requestVisibleCommitChecks",
    hashes: ["aaa1111", "bbb2222", "ccc3333"],
});
await vi.waitFor(() => expect(providerGetChecks).toHaveBeenCalledWith("aaa1111", { force: false }));
await webview.send({ type: "requestVisibleCommitChecks", hashes: [] });
resolveFirst(successSnapshot("aaa1111"));
await firstDemand;

expect(providerGetChecks).toHaveBeenCalledTimes(1);
expect(postMessageSpy).not.toHaveBeenCalledWith(
    expect.objectContaining({
        type: "setCommitChecks",
        snapshot: expect.objectContaining({ hash: "aaa1111" }),
    }),
);
```

Also add tests for duplicate hashes and more than 200 hashes.

Expected before implementation: stale batches continue with `Promise.all` and stale results post.

- [ ] **Step 2: Add a dedicated demand generation**

Add to both providers:

```ts
private commitCheckDemandSeq = 0;
private static readonly MAX_VISIBLE_COMMIT_CHECKS = 200;
```

Increment `commitCheckDemandSeq` when:

- a new `requestVisibleCommitChecks` message arrives;
- repository filters/reset clear loaded hash scope;
- undocked repository state resets;
- provider is disposed.

Do not reuse graph-log `requestSeq`; the two lifecycles are related but independent.

- [ ] **Step 3: Validate and deduplicate the batch**

Replace `assertCommitCheckHashes` with:

```ts
private assertVisibleCommitCheckHashes(
    msg: Extract<CommitGraphOutbound, { type: "requestVisibleCommitChecks" }>,
): string[] {
    if (!Array.isArray(msg.hashes)) throw new Error("Expected commit-check hashes array.");
    if (msg.hashes.length > CommitGraphViewProvider.MAX_VISIBLE_COMMIT_CHECKS) {
        throw new Error("Too many visible commit-check hashes.");
    }
    return Array.from(new Set(msg.hashes.map((hash) => assertGitHash(hash, "hashes"))));
}
```

Use the provider's class name in the undocked version. Preserve strict webview-boundary validation.

- [ ] **Step 4: Process one commit at a time**

Replace `Promise.all` with a generation-checked loop:

```ts
private async sendVisibleCommitChecksRequest(
    msg: Extract<CommitGraphOutbound, { type: "requestVisibleCommitChecks" }>,
): Promise<void> {
    const generation = ++this.commitCheckDemandSeq;
    const hashes = this.assertVisibleCommitCheckHashes(msg);
    for (const hash of hashes) {
        if (generation !== this.commitCheckDemandSeq) return;
        await this.sendCommitChecksIfCheckable(hash, generation, msg.force === true);
    }
}
```

Sequential per-surface processing is deliberate. The existing shared gate still allows concurrency across graph, sidebar, and undocked surfaces, while a viewport replacement can discard every not-yet-started hash.

- [ ] **Step 5: Guard the response post**

`sendCommitChecksIfCheckable` and `sendCommitChecks` must verify the same generation after awaiting provider work and before posting `setCommitChecks`:

```ts
const snapshot = await this.commitChecks.getChecks(hash, { force });
if (generation !== this.commitCheckDemandSeq) return;
this.postToWebview({ type: "setCommitChecks", snapshot });
```

Keep current `loadedCommitHashes`, `checkableCommitHashes`, and unpushed `none` behavior. Do not replace those guards with viewport validation; they protect different trust boundaries.

- [ ] **Step 6: Run provider integration tests**

```bash
rtk bun vitest run tests/integration/extension/view-providers.integration.test.ts
```

Expected: PASS for docked and undocked providers; stale demand starts no second hash and posts no stale first result.

- [ ] **Step 7: Commit**

Run GitNexus `detect_changes` first.

```bash
rtk git add \
  src/views/CommitGraphViewProvider.ts \
  src/views/UndockedViewProvider.ts \
  tests/integration/extension/view-providers.integration.test.ts
rtk git commit -m "fix(commit-checks): cancel stale viewport demand"
```

## 8. Task 3: Bound Retry Behavior by State

**Files:**

- Modify: `src/webviews/react/commit-list/checksRefresh.ts`
- Modify: `src/webviews/react/CommitList.tsx`
- Modify: `src/webviews/react/CommitGraphPanel.tsx`
- Modify: `src/webviews/react/NativeCommitGraph.tsx`
- Modify: `src/webviews/react/UndockedApp.tsx`
- Modify: `src/webviews/react/undocked/UndockedLayout.tsx`
- Test: `tests/webview/unit/low-coverage-components.test.tsx`

- [ ] **Step 1: Replace old retry constants with explicit schedules**

```ts
export const PENDING_CHECK_RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;
export const HEAD_NONE_CHECK_RETRY_DELAYS_MS = [30_000, 60_000] as const;

export function retryDelaysForCommitChecks(
    snapshot: CommitChecksSnapshot,
    options: { isCurrentHead: boolean; isUnpushed: boolean },
): readonly number[] {
    if (snapshot.state === "pending") return PENDING_CHECK_RETRY_DELAYS_MS;
    if (snapshot.state === "none" && options.isCurrentHead && !options.isUnpushed) {
        return HEAD_NONE_CHECK_RETRY_DELAYS_MS;
    }
    return [];
}
```

Delete `MAX_NONE_REFRESH_ATTEMPTS` and delete `shouldRequestCommitChecks` if it has no remaining callers after Task 1.

- [ ] **Step 2: Pass current branch HEAD explicitly**

Add `currentBranchHeadHash?: string | null` to `CommitList` props. Each parent computes it from:

```ts
const currentBranch = branches.find((branch) => branch.isCurrent && !branch.isRemote);
const currentBranchName = currentBranch?.name ?? null;
const currentBranchHeadHash = currentBranch?.hash ?? null;
```

Pass both name and hash through full, compact, and undocked graph layouts.

- [ ] **Step 3: Add one bounded retry timer**

Store attempts by hash and state so a state transition resets its budget:

```ts
type RetryAttempt = { state: CommitChecksSnapshot["state"]; attempt: number };
const checkRetryAttempts = useRef(new Map<string, RetryAttempt>());
```

For exact-visible commits only:

1. read the snapshot;
2. delete attempts for missing/loading/terminal/unavailable snapshots;
3. select the delay array from `retryDelaysForCommitChecks`;
4. reset attempt to zero when snapshot state changed;
5. schedule the minimum next delay;
6. on timer, increment only hashes due at that delay and call `onRequestCommitChecks(dueHashes, true)`;
7. clear timer on viewport/state change and unmount.

Do not call the request callback directly for `unavailable`.

- [ ] **Step 4: Replace retry tests**

Required assertions using fake timers:

```text
pending visible: calls at 30s, +60s, +120s; no fourth call
pending offscreen: zero calls
none current HEAD: calls at 30s and +60s; no third call
none non-HEAD: zero calls
none unpushed HEAD: zero calls
unavailable: zero calls after advancing one hour
success/failure/skipped: zero calls
```

Every timer-driven call must assert `force === true`.

- [ ] **Step 5: Run focused tests**

```bash
rtk bun vitest run \
  tests/webview/unit/low-coverage-components.test.tsx \
  tests/integration/webviews/react-context.integration.test.tsx
```

Expected: PASS with fake timers fully drained and restored in `finally` blocks.

- [ ] **Step 6: Commit**

Run GitNexus `detect_changes` first.

```bash
rtk git add \
  src/webviews/react/commit-list/checksRefresh.ts \
  src/webviews/react/CommitList.tsx \
  src/webviews/react/CommitGraphPanel.tsx \
  src/webviews/react/NativeCommitGraph.tsx \
  src/webviews/react/UndockedApp.tsx \
  src/webviews/react/undocked/UndockedLayout.tsx \
  tests/webview/unit/low-coverage-components.test.tsx
rtk git commit -m "fix(commit-checks): bound visible retry schedules"
```

## 9. Task 4: Add State-Specific Cache TTL and Forced HEAD Refresh

**Files:**

- Modify: `src/services/commitChecks/service.ts`
- Modify: `src/services/commitChecks/persistentCache.ts`
- Modify: `src/services/commitChecks/coordinator.ts`
- Modify: `src/activation/repositoryMode.ts`
- Modify: `src/views/CommitGraphViewProvider.ts`
- Modify: `src/views/UndockedViewProvider.ts`
- Test: `tests/unit/services/commitChecks/service.test.ts`
- Test: `tests/unit/services/commitChecks/persistentCache.test.ts`
- Test: `tests/unit/services/commitChecks/coordinator.test.ts`

- [ ] **Step 1: Add failing cache-policy tests**

Add tests proving:

```text
none survives a new service instance for 1h
none expires after 1h
pending is not persisted
unavailable is not persisted
unavailable remains fresh in L1 for 15m
forced get skips fresh L1/L2
forced concurrent gets still share one in-flight fetch
```

Example force test:

```ts
await service.getOrFetch(
    key,
    vi.fn(async () => snapshot("none")),
);
const forcedFetch = vi.fn(async () => snapshot("pending"));
const refreshed = await service.getOrFetch(key, forcedFetch, { force: true });
expect(forcedFetch).toHaveBeenCalledTimes(1);
expect(refreshed.state).toBe("pending");
```

Expected before implementation: FAIL because `none` is not persisted and no force option exists.

- [ ] **Step 2: Add service TTL options**

Preserve `ttlMs` as the pending TTL to limit churn in existing tests. Add:

```ts
export interface CommitChecksServiceOptions {
    ttlMs?: number;
    noneTtlMs?: number;
    unavailableTtlMs?: number;
    maxEntries?: number;
    now?: () => number;
    persistentCache?: CommitChecksPersistentCache;
}

const DEFAULT_PENDING_TTL_MS = 30_000;
const DEFAULT_NONE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_UNAVAILABLE_TTL_MS = 15 * 60 * 1000;
```

Implement freshness with an explicit switch. Terminal states remain fresh in L1 until LRU eviction.

- [ ] **Step 3: Add force bypass**

```ts
async getOrFetch(
    key: string,
    fetchSnapshot: () => Promise<CommitChecksSnapshot>,
    options: { force?: boolean } = {},
): Promise<CommitChecksSnapshot> {
    if (!options.force) {
        const cached = this.cache.get(key);
        if (cached && this.isFresh(cached)) return cached.snapshot;
    }
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    if (!options.force && this.persistentCache) {
        // existing L2 lookup
    }
    // existing shared fetch and write path
}
```

The in-flight check must occur for both normal and forced calls.

- [ ] **Step 4: Persist negative `none` snapshots**

In `persistentCache.ts`:

```ts
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NONE_MAX_AGE_MS = 60 * 60 * 1000;

export function isPersistentCommitCheckState(state: CommitCheckState): boolean {
    return state !== "pending" && state !== "unavailable";
}
```

Use `noneMaxAgeMs` for `none`; retain `maxAgeMs` for all terminal states. Do not persist `loading` because it is a webview-only sentinel, not a snapshot state.

- [ ] **Step 5: Forward force through coordinator and hosts**

```ts
async getChecks(hash: string, options: { force?: boolean } = {}): Promise<CommitChecksSnapshot> {
    if (!this.enabled) return this.noneSnapshot(hash);
    return this.fetchFresh(hash, options);
}
```

Pass `options` into `service.getOrFetch`. Host providers pass `{ force }` from `requestVisibleCommitChecks`.

- [ ] **Step 6: Wire production TTLs**

In `repositoryMode.ts`:

```ts
const commitChecksService = new CommitChecksService({
    ttlMs: 30_000,
    noneTtlMs: 60 * 60 * 1000,
    unavailableTtlMs: 15 * 60 * 1000,
    maxEntries: 1_000,
    persistentCache: new CommitChecksPersistentCache(context.globalState, {
        noneMaxAgeMs: 60 * 60 * 1000,
    }),
});
```

- [ ] **Step 7: Run cache tests**

```bash
rtk bun vitest run \
  tests/unit/services/commitChecks/service.test.ts \
  tests/unit/services/commitChecks/persistentCache.test.ts \
  tests/unit/services/commitChecks/coordinator.test.ts \
  tests/integration/extension/view-providers.integration.test.ts
```

Expected: PASS. A fresh normal `none` hit causes zero fetches; a forced HEAD retry causes one fetch.

- [ ] **Step 8: Commit**

Run GitNexus `detect_changes` first.

```bash
rtk git add \
  src/services/commitChecks/service.ts \
  src/services/commitChecks/persistentCache.ts \
  src/services/commitChecks/coordinator.ts \
  src/activation/repositoryMode.ts \
  src/views/CommitGraphViewProvider.ts \
  src/views/UndockedViewProvider.ts \
  tests/unit/services/commitChecks/service.test.ts \
  tests/unit/services/commitChecks/persistentCache.test.ts \
  tests/unit/services/commitChecks/coordinator.test.ts \
  tests/integration/extension/view-providers.integration.test.ts
rtk git commit -m "feat(commit-checks): cache negative results with bounded refresh"
```

## 10. Task 5: Make the GitHub Gate Proactive

**Files:**

- Modify: `src/services/commitChecks/http.ts`
- Modify: `src/services/commitChecks/requestGate.ts`
- Modify: `src/activation/repositoryMode.ts`
- Test: `tests/unit/services/commitChecks/http.test.ts`
- Test: `tests/unit/services/commitChecks/requestGate.test.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Add failing successful-header test**

Extend the HTTP test to assert an observer receives successful metadata:

```ts
const observe = vi.fn();
const fetchJson = createHttpGetJson(observe);
const promise = fetchJson("https://api.test/x", {});
res.emit("data", Buffer.from("{}"));
res.emit("end");
await promise;
expect(observe).toHaveBeenCalledWith({
    statusCode: 200,
    headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "99",
        "x-ratelimit-reset": "3600",
    },
});
```

Expected before implementation: FAIL because only parsed JSON is returned.

- [ ] **Step 2: Add a small HTTP observer factory**

Keep provider return values unchanged:

```ts
export interface HttpResponseMetadata {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
}

export function createHttpGetJson(
    onResponse?: (metadata: HttpResponseMetadata) => void,
): FetchJson {
    return (url, headers) =>
        new Promise((resolve, reject) => {
            const req = https.get(url, { headers }, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer | string) => {
                    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
                });
                res.on("end", () => {
                    req.setTimeout(0);
                    const statusCode = res.statusCode ?? 0;
                    try {
                        onResponse?.({ statusCode, headers: res.headers });
                    } catch {
                        // Response observation must never change provider IO behavior.
                    }
                    const data = Buffer.concat(chunks).toString("utf8");
                    if (statusCode < 200 || statusCode >= 300) {
                        reject(
                            new HttpError(
                                statusCode,
                                `HTTP ${statusCode}: ${data.slice(0, 200)}`,
                                res.headers,
                            ),
                        );
                        return;
                    }
                    try {
                        resolve(data ? JSON.parse(data) : {});
                    } catch {
                        reject(new Error("Invalid JSON response"));
                    }
                });
            });
            req.on("error", reject);
            req.setTimeout(15000, () => {
                req.destroy(new Error("HTTP request timed out"));
            });
        });
}

export const httpGetJson = createHttpGetJson();
```

Observer failures must be swallowed so diagnostics cannot break provider IO. Do not include request headers or access tokens in metadata.

- [ ] **Step 3: Add proactive quota tests**

Required gate tests:

```text
successful remaining=501 with limit=5000 allows next task
successful remaining=500 with limit=5000 blocks next task (10% reserve = 500)
successful remaining=100 with limit=1000 blocks next task (minimum reserve = 100)
300 started tasks in rolling hour blocks task 301
after oldest timestamp leaves rolling hour, task proceeds
blocked task does not invoke HTTP and does not consume local budget
reset clears observed account quota and local rolling timestamps
existing primary 403 cooldown still works
existing secondary retry-after cooldown still works
```

- [ ] **Step 4: Track observed budget in `GitHubRequestGate`**

Use constants, not settings:

```ts
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const MAX_AUTOMATIC_REQUESTS_PER_WINDOW = 300;
const MIN_PRIMARY_RESERVE = 100;
const PRIMARY_RESERVE_RATIO = 0.1;
```

Add fields:

```ts
private readonly startedAt: number[] = [];
private rateLimit = 0;
private rateRemaining: number | undefined;
private rateResetAt = 0;
```

Add public methods:

```ts
observeResponse(metadata: HttpResponseMetadata): void;
reset(): void;
```

`observeResponse` parses only finite non-negative values. If remaining is at or below the reserve and reset is in the future, set the existing shared cooldown to reset time.

Before a task starts:

1. prune rolling timestamps older than one hour;
2. throw the existing generic cooldown `HttpError` if quota reserve is active;
3. if 300 starts already exist in the window, set cooldown to `oldest + 1h` and throw;
4. acquire semaphore;
5. repeat checks because state may have changed while queued;
6. record start timestamp immediately before calling HTTP.

Use the existing message `GitHub rate limit cooldown is active.` to avoid adding a new localized UI string.

- [ ] **Step 5: Wire observed GitHub HTTP only**

```ts
const githubRequestGate = new GitHubRequestGate(4);
const githubHttpGetJson = createHttpGetJson((metadata) => {
    githubRequestGate.observeResponse(metadata);
});
const gatedGithubFetchJson: FetchJson = (url, headers) =>
    githubRequestGate.run(() => githubHttpGetJson(url, headers));
```

GitLab and Bitbucket continue using plain `httpGetJson`.

The existing manual `intelligit.commitChecks.refreshBadges` command clears snapshots but must not call `githubRequestGate.reset()`.

The GitHub auth-session listener must reset account-scoped gate state before refreshing:

```ts
if (event.provider.id !== "github") return;
githubRequestGate.reset();
void refreshCommitCheckBadges().catch((err) => {
    console.error("[IntelliGit] GitHub commit-check refresh failed:", err);
});
```

- [ ] **Step 6: Run gate and activation tests**

```bash
rtk bun vitest run \
  tests/unit/services/commitChecks/http.test.ts \
  tests/unit/services/commitChecks/requestGate.test.ts \
  tests/unit/services/commitChecks/githubProvider.test.ts \
  tests/integration/extension/view-providers.integration.test.ts
```

Expected: PASS. A successful response showing low quota prevents the next HTTP task; no `403` is needed to learn the cooldown.

- [ ] **Step 7: Commit**

Run GitNexus `detect_changes` first.

```bash
rtk git add \
  src/services/commitChecks/http.ts \
  src/services/commitChecks/requestGate.ts \
  src/activation/repositoryMode.ts \
  tests/unit/services/commitChecks/http.test.ts \
  tests/unit/services/commitChecks/requestGate.test.ts \
  tests/integration/extension/view-providers.integration.test.ts
rtk git commit -m "fix(commit-checks): stop before github quota exhaustion"
```

## 11. Task 6: Restore Changed-File Counts Before Git Refresh

**Files:**

- Modify: `src/views/commitPanelRepositoryRuntime.ts`
- Modify: `src/views/CommitPanelViewProvider.ts`
- Modify: `src/activation/repositoryMode.ts`
- Test: `tests/integration/extension/view-providers.integration.test.ts`

- [ ] **Step 1: Add failing startup-cache tests**

Use the existing `createMemento` helper with:

```ts
const storedCounts = {
    "intelligit.changedFileCounts.v1": {
        schemaVersion: 1,
        entries: [
            { root: "/repo-a", includeIgnored: false, count: 2, updatedAt: 1_000 },
            { root: "/repo-b", includeIgnored: false, count: 3, updatedAt: 1_000 },
        ],
    },
};
```

Inject `now` through a small private/static helper only if the existing test clock cannot control `Date.now`; otherwise use `vi.setSystemTime`.

Required tests:

```text
cached aggregate 5 is available before getStatus resolves
cached repository rows expose counts 2 and 3 immediately
fresh status result replaces and persists the cached count
cached zero is restored as a valid value
failed getStatus keeps stale count
stale/corrupt/negative/fractional entries are ignored
switching active repository does not clear aggregate badge to zero
removed repositories no longer contribute to aggregate
```

Expected before implementation: FAIL because runtimes start with empty files and activation resets the badge.

- [ ] **Step 2: Add runtime fallback state**

```ts
lastKnownChangedFileCount: number | null = null;
```

Keep `hasScannedFileCount`. Meaning:

```text
hasScannedFileCount=false, lastKnown=null   -> unknown, display 0
hasScannedFileCount=false, lastKnown=N      -> stale cache, display N
hasScannedFileCount=true                    -> derive from runtime.files
```

- [ ] **Step 3: Load and validate storage once**

Add the payload interfaces near `CommitPanelViewProvider`. Add constants:

```ts
private static readonly CHANGED_FILE_COUNT_KEY = "intelligit.changedFileCounts.v1";
private static readonly CHANGED_FILE_COUNT_SCHEMA_VERSION = 1;
private static readonly CHANGED_FILE_COUNT_MAX_ENTRIES = 100;
private static readonly CHANGED_FILE_COUNT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
```

Load into one in-memory `Map<string, StoredChangedFileCount>` during construction. Composite key:

```ts
private changedFileCountKey(root: string, includeIgnored: boolean): string {
    return `${root}\u0000${includeIgnored ? "ignored" : "tracked"}`;
}
```

Validate every persisted field. Ignore the whole payload when schema version is wrong; ignore individual invalid entries without throwing.

- [ ] **Step 4: Hydrate each newly created runtime**

Immediately after constructing a runtime in `setRepositoriesInternal`:

```ts
const runtime = new CommitPanelRepositoryRuntime(repository, gitOps);
runtime.lastKnownChangedFileCount = this.getStoredChangedFileCount(runtime);
this.runtimes.set(repository.root, runtime);
```

Call `updateAggregateChangedFileCount()` once after the repository map is updated, even when repositories were added without changing the active root. This keeps `lastFileCount` correct before activation subscribes.

- [ ] **Step 5: Use cached fallback without fake files**

```ts
private countChangedFiles(runtime: CommitPanelRepositoryRuntime | undefined): number {
    if (!runtime) return 0;
    if (!runtime.hasScannedFileCount && runtime.lastKnownChangedFileCount !== null) {
        return runtime.lastKnownChangedFileCount;
    }
    const uniquePaths = new Set<string>();
    for (const file of runtime.files) {
        if (file.status !== "!") uniquePaths.add(file.path);
    }
    return uniquePaths.size;
}
```

Do not create placeholder `WorkingFile` entries. Cached counts are display state, not file data.

- [ ] **Step 6: Persist only fresh counts**

After either `scanRepositoryFileCount` or `refreshRepositoryData` accepts a current status result:

```ts
runtime.files = files;
runtime.hasScannedFileCount = true;
runtime.lastKnownChangedFileCount = this.countChangedFiles(runtime);
this.storeChangedFileCount(runtime);
this.updateAggregateChangedFileCount();
```

`storeChangedFileCount` updates the in-memory map immediately, trims stale/old entries, serializes writes through one promise chain, and skips `workspaceState.update` when root/includeIgnored/count are unchanged.

Do not write from error paths. A failed scan leaves `hasScannedFileCount=false` and preserves the stale fallback.

- [ ] **Step 7: Expose synchronous aggregate and remove zero resets**

Add:

```ts
/** Returns the aggregate count already known from fresh or persisted repository state. */
getLastKnownFileCount(): number {
    return this.aggregateChangedFileCount();
}
```

In activation:

```ts
const fileCountBadgeSubscription = commitPanel.onDidChangeFileCount(updateFileCountBadge);
updateFileCountBadge(commitPanel.getLastKnownFileCount());
```

Delete `resetFileCountBadge` and its calls at activation and repository switch. Current badge semantics are workspace aggregate, so an active-repository switch must not transiently clear it.

- [ ] **Step 8: Run file-count tests**

```bash
rtk bun vitest run \
  tests/integration/extension/view-providers.integration.test.ts \
  tests/webview/unit/commit-panel-multi-repo.test.tsx
```

Expected: PASS. Cached aggregate is observable before any pending `getStatus` promise resolves; fresh status later replaces it.

- [ ] **Step 9: Commit**

Run GitNexus `detect_changes` first.

```bash
rtk git add \
  src/views/commitPanelRepositoryRuntime.ts \
  src/views/CommitPanelViewProvider.ts \
  src/activation/repositoryMode.ts \
  tests/integration/extension/view-providers.integration.test.ts
rtk git commit -m "fix(changes): restore cached file counts on startup"
```

## 12. Task 7: End-to-End Idle Regression and Multi-Repo Bound

**Files:**

- Modify: `tests/integration/extension/view-providers.integration.test.ts`
- Modify only if needed: `tests/webview/unit/low-coverage-components.test.tsx`

- [ ] **Step 1: Add a three-minute fake-clock regression**

Model:

```text
30 discovered repositories
1 active repository
12 exact-visible commits
all GitHub responses return none
current branch HEAD is one of the 12
clock advances 3 minutes
```

Assertions for REST implementation:

```text
inactive repositories: 0 provider calls
11 non-HEAD commits: 1 provider fetch each
current HEAD: 3 provider fetches total (initial + two forced retries)
provider fetches total: 14
GitHub HTTP calls total: 28
no unavailable/none timer remains after budget exhaustion
```

This test is the primary regression for the reported untouched-workspace failure.

- [ ] **Step 2: Add a pending bound variant**

For 12 visible commits all returning pending:

```text
provider fetches per commit: at most 4
provider fetches total after all retries: at most 48
HTTP calls total: at most 96
after final 120s retry and response, another hour causes zero calls
```

- [ ] **Step 3: Add low-quota variant**

First successful response reports:

```text
x-ratelimit-limit: 5000
x-ratelimit-remaining: 100
x-ratelimit-reset: future timestamp
```

Assert every subsequent queued GitHub HTTP task is blocked before invoking the injected HTTP boundary.

- [ ] **Step 4: Run all commit-check and multi-repo tests**

```bash
rtk bun vitest run \
  tests/unit/services/commitChecks \
  tests/webview/unit/low-coverage-components.test.tsx \
  tests/webview/unit/commit-panel-multi-repo.test.tsx \
  tests/integration/webviews/commitChecksEnabled-gating.integration.test.tsx \
  tests/integration/webviews/react-context.integration.test.tsx \
  tests/integration/extension/view-providers.integration.test.ts
```

Expected: PASS. Request-count assertions must use exact numbers for `none` and upper bounds for pending due shared in-flight deduplication.

- [ ] **Step 5: Commit**

Run GitNexus `detect_changes` first.

```bash
rtk git add \
  tests/integration/extension/view-providers.integration.test.ts \
  tests/webview/unit/low-coverage-components.test.tsx
rtk git commit -m "test(commit-checks): cover idle multi-repo request bounds"
```

## 13. Task 8: Full Validation, Manual Verification, and Release Metadata

**Files:**

- Modify: `CHANGELOG.md`
- Modify after all gates pass: `package.json`

- [ ] **Step 1: Run standard validation**

Run in this order:

```bash
rtk bun run format:check
rtk bun run lint
rtk bun run architecture:check
rtk bun run react-doctor
rtk bun run typecheck
rtk bun run build
rtk bun run test
```

Expected: every command exits 0. Do not claim success for skipped commands.

No new user-facing English string is required by this plan. If implementation introduces one, also run:

```bash
rtk bun run l10n:sync
rtk bun run l10n:translate -- --only-missing
rtk bun run l10n:import
rtk bun scripts/localization-csv.js validate
rtk bun run l10n:validate
rtk bun run l10n:audit
```

If a listed script is absent, state that fact and run the closest existing validation command instead.

- [ ] **Step 2: Run Extension Host smoke test**

1. Use VS Code launch configuration `Run Extension`; it runs `bun run build` first.
2. In the Extension Development Host, open `<workspace-root>`.
3. Open IntelliGit and leave graph visible without scrolling or selecting a repository for five minutes.
4. Confirm no raw `HTTP 403` appears.
5. Confirm only active repository rows receive commit-check badges.
6. Reload the Extension Development Host.
7. Confirm terminal and `none` badges restore without an immediate full refetch.
8. Close/hide the graph for one minute, reopen it, and confirm no burst for commits outside the reopened viewport.
9. Make a local file change, reload once, and confirm the previous count appears immediately before refreshing to the new count.
10. Revert the temporary local file change through normal Git/UI operations; do not use destructive reset commands.

- [ ] **Step 3: Record evidence**

The implementation summary must include:

```text
focused tests run and result
full validation commands run and result
cold exact-visible commit count
idle duration
whether any 403 appeared
warm reload provider/HTTP call count from automated test
cached file count before status resolution
fresh file count after status resolution
```

Do not declare the incident fixed from green unit tests alone. Manual untouched-workspace verification is required.

- [ ] **Step 4: Update changelog**

Prepend:

```markdown
## [0.17.2] - 2026-07-11

### Fixed

- Limited GitHub commit-check loading to exact visible graph rows with bounded pending and current-HEAD retries, preventing idle multi-repository workspaces from exhausting the shared REST quota.
- Cached no-check results across reloads and stopped background requests before GitHub's remaining quota reaches zero.
- Restored last-known multi-repository changed-file counts immediately on startup while fresh Git status scans reconcile the result.
```

- [ ] **Step 5: Bump version only now**

Change `package.json` version from `0.17.1` to `0.17.2`. Do not edit dependency versions.

- [ ] **Step 6: Run release checks**

```bash
rtk bun run build:prod
rtk bun run package
```

Expected: both exit 0. Do not publish.

- [ ] **Step 7: Final commit**

Run GitNexus `detect_changes({scope: "compare", base_ref: "main"})` and inspect `rtk git diff --check`.

```bash
rtk git add CHANGELOG.md package.json
rtk git commit -m "chore(release): bump version to 0.17.1"
```

## 14. Acceptance Matrix

| Scenario                                   | Required result                                                    |
| ------------------------------------------ | ------------------------------------------------------------------ |
| 30 repositories discovered, no interaction | Only active repository exact viewport creates demand               |
| Render overscan                            | Renders smoothly but creates zero extra check requests             |
| Scroll while first batch runs              | At most one old commit completes; remaining old hashes never start |
| Repository switch                          | Old generation posts no check snapshots                            |
| Two graph surfaces, same repo/SHA          | Shared service performs one provider fetch per freshness window    |
| `none`, non-HEAD                           | One fetch, then one-hour cache                                     |
| `none`, current HEAD                       | Initial fetch plus two forced retries, then stop                   |
| `pending`                                  | Initial fetch plus three forced retries while visible, then stop   |
| `unavailable`                              | No timer retry; L1 protects re-entry for 15 minutes                |
| Terminal check                             | L2 restores for 24 hours                                           |
| GitHub remaining reaches reserve           | Next HTTP task is blocked before network                           |
| Local rolling budget reaches 300           | Task 301 is blocked until oldest start expires                     |
| Manual badge refresh under low quota       | Cache clears; gate still blocks network                            |
| GitHub account session changes             | Cache refreshes and gate account state resets                      |
| Cached file count is 0                     | Zero is restored as valid state, not treated as missing            |
| Cached file count is stale                 | Stale value appears immediately, then fresh status replaces it     |
| Status scan fails                          | Stale count remains visible                                        |
| Repository removed                         | Its count stops contributing to aggregate                          |

## 15. Deferred Work and Promotion Gates

### GraphQL batching

Do not add GraphQL during this fix. Consider a separate plan only if post-fix measurements show normal exact-viewport cold loads still consume unacceptable quota.

Promotion criteria:

```text
REST implementation passes every acceptance test
request count remains problematic in measured normal use
GraphQL statusCheckRollup output matches REST normalization fixtures
partial errors map per SHA without failing whole batch
query cost and remaining GraphQL budget are recorded
batch size is capped at 20 SHAs
REST fallback remains available until parity is proven
```

### Conditional REST requests

Do not add ETag persistence during this fix. It requires retaining endpoint-specific check-run and status payloads or normalized components so mixed `304`/`200` responses can be merged correctly. Add it only if warm cache revalidation becomes a measured quota source after negative caching and demand bounds ship.

## 16. Final Self-Review Checklist

- [ ] Every required behavior maps to a task and a test.
- [ ] No task fetches commit checks for all discovered repositories.
- [ ] No timer path includes `unavailable`.
- [ ] `none` persistence and forced current-HEAD retry are both covered.
- [ ] Force bypass still honors in-flight deduplication and quota gate.
- [ ] Current uncommitted loaded/unpushed hash guards remain intact.
- [ ] File counts are cached independently from `WorkingFile[]`.
- [ ] Zero file count is represented explicitly.
- [ ] Manual refresh does not reset quota budget.
- [ ] Auth change resets quota budget.
- [ ] No new dependency or settings surface was introduced.
- [ ] Full validation and five-minute untouched smoke test were actually run.
- [ ] Version/changelog changes happen only after functional acceptance.
