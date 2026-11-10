# Plan Review Log: CI Checks tab
Started 2026-11-07. MAX_ROUNDS=2. Reviewer: gpt-6-astra/xhigh.

Owner decisions before review (2026-11-07): C1–C4 took the proposed rules; C3 also adds a README section on `pipeline` / `pipeline:write`.
SID: 01a1b6a6-c0ba-7293-8919-e29165d95b15

## Round 1 — Codex (gpt-6-astra, effort xhigh)

R1 MET — Goal and feature-to-phase map, PLAN.md:4–32; all 15 locked features have phase entries.
R2 MET — Reference behaviour, PLAN.md:34–43; named behavioural sources, visual references and provider documentation.
R3 PARTIAL — Current state and gap, PLAN.md:45–79; several assumptions contradict the current code.
R4 PARTIAL — User journeys, PLAN.md:85–132; reload, concurrent-window and repeated-action sequences remain incomplete.
R5 PARTIAL — Technical design, PLAN.md:149–394; required data fields, identity boundaries and transport contracts are missing.
R6 PARTIAL — Failure and recovery / Safety, migrations and rollout, PLAN.md:134–147 and 462–520; cache, storage and notification recovery are unsafe.
R7 PARTIAL — Edge cases and acceptance evidence, PLAN.md:522–550; several stated mutations can survive the proposed tests.
R8 PARTIAL — Phases, PLAN.md:562–782; Phase 9 omits a dependency it explicitly consumes.
R9 PARTIAL — Check commands and phase gates, PLAN.md:395–403 and 554–773; repository-required checks and new runtime UI coverage are missing.
R10 PARTIAL — Contracts, decisions and provenance, PLAN.md:409–439 and 786–853; scope reductions are marked resolved without corresponding owner decisions.

1. [CRITICAL] PLAN.md:220,239,342–347 — The plan equates aggregate failure with settlement, but `src/services/commitChecks/normalize.ts:36–42` returns failure while other checks remain pending, causing premature immutable caching, stopped polling and an early toast. Fix: Represent completion separately from outcome and test a failed job alongside a still-running job through final settlement.
2. [CRITICAL] PLAN.md:143,297,656 — Force-refresh does not safely invalidate a re-run because `service.ts:76–82` joins pre-existing fetches and `persistentCache.ts:98–99` leaves the previous settled entry intact when the new result is pending, allowing stale results to win or reappear after restart. Fix: Fence pre-action reads with a per-key generation, durably invalidate both cache layers, and verify the action’s resulting state before restoring terminal caching.
3. [CRITICAL] PLAN.md:278–281 — Two VS Code windows share the same deterministic `.part` path, while deduplication is process-local and either window’s activation deletes all `.part` files, so concurrent downloads or opening another window can corrupt or delete an active download. Fix: Use uniquely owned temporary files, atomic publication and coordinated shared-storage cleanup, with a two-process interruption test.
4. [CRITICAL] PLAN.md:240,256,347,357,603 — Hash/requestId and HEAD-only guards omit repository, credential and lifecycle generations, allowing stale data after switching between repositories sharing a SHA or repopulating diagnostics after disable/sign-out without a HEAD change. Fix: Bind every operation and result to repository/authentication/lifecycle generations and recheck them after awaits and before publishing.
5. [CRITICAL] PLAN.md:347–349 — The in-memory toast Set cannot prevent two extension hosts from both reading an absent record, writing it and showing a toast, so the claimed single-thread protection does not establish once-per-hash behaviour across windows. Fix: Define the deduplication scope and use an atomic shared claim or a single notification owner, tested with concurrent hosts.
6. [REQUIRED] PLAN.md:284–285,384,759 — Credential stripping is specified only for GitHub, although Bitbucket Cloud log downloads can return a 307 redirect, leaving its downloader without a safe redirect contract. Fix: Specify bounded HTTPS redirect handling and removal of all credential headers on origin changes for every provider, including chained redirects ([Bitbucket API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/)).
7. [REQUIRED] PLAN.md:264,427–428,466–468 — The log excerpt protocol contradicts BRIEF.md’s prohibition on log content in webview state and journey 5’s promise that no log text reaches the webview. Fix: Remove excerpts from webview messages and retain only provider failure summaries, rendered as escaped text with hostile-content tests.
8. [REQUIRED] PLAN.md:355–358 — Annotation paths and ranges are mapped directly without a contract for repository containment, absolute paths, traversal, invalid line numbers or symlink escapes. Fix: Validate paths and ranges before creating diagnostics or opening files, and test rejected annotations without losing valid ones.
9. [REQUIRED] PLAN.md:215–232,498–511 — Persisting capabilities inside immutable `v:1` details means an earlier release’s `logs:false`, `annotations:false` or floor capabilities can survive later feature releases for 24 hours. Fix: Derive capabilities from the installed provider at read time and version or invalidate cached enrichment whenever its contract changes.
10. [REQUIRED] PLAN.md:221–232,765–771 — Bitbucket Server cannot deliver its promised duration, required and usual-duration fields through `otherChecks: CommitCheckItem[]`, whose existing type has none of them, and the floor adapter explicitly replaces capabilities with all-false values. Fix: Define an enriched flat-check model and a Server detail adapter that preserves implemented capabilities.
11. [REQUIRED] PLAN.md:199–213,287,355,681 — Later phases require a check-run identifier/metadata and workflow identity, but the frozen `CiJob` and `CiRun` contracts retain neither the referenced `check_run_url` nor `workflow_id` or annotation metadata. Fix: Specify retained provider metadata or explicit lookup methods in Phase 1, including the distinction between Actions job IDs and check-run IDs.
12. [REQUIRED] PLAN.md:242,569,589,355 — GitHub run/job reads, GitLab pipeline reads and annotation reads lack complete pagination contracts, so later-page failures or diagnostics can disappear from an apparently complete result. Fix: Follow pagination at every collection boundary and test failures on the second and final pages; any approved bound must produce an explicit incomplete state ([GitHub jobs](https://docs.github.com/en/rest/actions/workflow-jobs), [annotations](https://docs.github.com/en/rest/checks/runs#list-check-run-annotations)).
13. [REQUIRED] PLAN.md:589–590,682 — GitLab’s project pipeline-list response does not supply the planned user and duration data, and the current `FetchJson` contract exposes only the body rather than the `x-next-page` header the phase needs. Fix: Add the single-pipeline detail request and a defined response-metadata transport before implementing header, duration and pagination mapping ([GitLab pipelines](https://docs.gitlab.com/api/pipelines/)).
14. [REQUIRED] PLAN.md:388,438,759–760 — C3’s fallback handles only a steps-request 403, although the initial pipeline-list request already requires pipeline-read permission and can fail before any steps request occurs. Fix: Preserve the existing flat snapshot and show the approved scope guidance when either pipeline discovery or step discovery is forbidden ([Bitbucket API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/)).
15. [REQUIRED] PLAN.md:231,242,325 — Removing and joining checks solely by name can hide an unrelated status or third-party check named like an Actions job and attach history from another workflow with the same job name. Fix: Deduplicate by provider identity and use name-based history only when the match is unique, otherwise show unknown.
16. [REQUIRED] PLAN.md:98–100,144,347,718 — Reloading while pending and receiving a settled first response suppresses the notification because pending observation is activation-local, contradicting journey 4’s promised notification after a mid-run reload. Fix: Persist pending-observation state and test settlement during the restart gap, with explicit owner-approved crash-delivery semantics.
17. [REQUIRED] PLAN.md:348,423 — Evicting toast records after 200 entries breaks “once per hash” when an evicted commit is revisited and re-run. Fix: Retain durable notification tombstones for the promised scope or obtain an explicit bounded-history contract.
18. [REQUIRED] PLAN.md:244,342,722 — Reusing the existing finite retry ladder does not monitor an ordinary long-running build to completion because `CommitList.tsx:548–554` stops when its eight rungs are exhausted, independently of the 20-attempt ceiling. Fix: Define budget-aware ongoing HEAD monitoring or obtain approval for bounded monitoring with a visible exhausted state and recovery action.
19. [REQUIRED] PLAN.md:370–378 — A loaded-row count is neither membership in the loaded history nor an ancestry chain, so the first-parent walk can leave the displayed range and bisect can attribute a failure across unrelated branches. Fix: Carry the actual selected/loaded hashes and parent relationships, and define ancestry-aware comparison or an explicitly non-causal result for divergent ranges.
20. [REQUIRED] PLAN.md:268,334–337,372–374,700 — Bisect fetches only snapshots, but its same-commit flaky classification requires attempt history that neither `CommitCheckItem` nor the history reply contains. Fix: Add a shared attempt-history contract used by both tree and bisect, including chronological ordering and deduplication of commits counted by both flaky rules.
21. [REQUIRED] PLAN.md:433,681–684 — The “previous successful run” query selects the latest success without excluding the selected run or newer runs, and its branch/workflow-only cache can reuse that future baseline for older commits. Fix: Define “previous” relative to the selected run, preserve workflow identity and include the baseline identity in cache semantics.
22. [REQUIRED] PLAN.md:378,703 — The changed-since-green click path does not specify how both revisions reach the host, while the existing `openCommitFileDiff` at `diffService.ts:866–907` compares a commit with its parent rather than with `lastGreen`. Fix: Define an explicit two-revision diff action and test multi-commit changes, additions, deletions, renames and unusual filenames.
23. [REQUIRED] PLAN.md:692 — Phase 9 declares only Phase 3 although it reuses `defaultBranch.ts` and its tests created in Phase 7, so the executable dependency graph permits it to start before its prerequisite. Fix: Add Phase 7 to Phase 9’s dependencies and regenerate the wave description from the corrected graph.
24. [REQUIRED] PLAN.md:153,244,563,572 — Placing shared capabilities and polling constants under `src/services` and importing them from React violates `.dependency-cruiser.cjs:24–32`, regardless of whether those files import `vscode`. Fix: Put browser/host shared contracts and constants in an allowed shared module and preserve the architecture rule.
25. [REQUIRED] PLAN.md:373,751 — Bisect cancellation does not specify how work already waiting inside the existing request gate is stopped, and `requestGate.ts:219–232` invokes its task after acquiring capacity without a cancellation check. Fix: Recheck cancellation inside the gated callback immediately before HTTP dispatch and test cancellation with all four gate slots occupied.
26. [REQUIRED] PLAN.md:280,427 — Evicting only before downloads cannot enforce the 200 MB directory cap when concurrent downloads reserve no space or open documents pin every eviction candidate. Fix: Define atomic space accounting and an explicit user-visible refusal or approved overflow policy when the bound cannot be maintained.
27. [REQUIRED] PLAN.md:395–403 and phase “Done when” gates — The prescribed validation omits repository-required format checking, react-doctor, localization translation/import and affected-path Impeccable detection for UI changes. Fix: Restore the applicable AGENTS.md checks, including strict documentation linting, and run localization before final validation.
28. [REQUIRED] PLAN.md:560,620,724,743 — Existing CI e2e tests and jsdom assertions cannot prove the new tree, editor navigation, toast actions or three-host message plumbing, yet the plan adds no runtime journeys exercising those features. Fix: Add focused VS Code runtime e2e tests to the explicit `test:e2e` inventory and verify the new controls in relevant themes and pane sizes.
29. [REQUIRED] PLAN.md:475–480,528,603,613 — The stale-reply mutation test exercises different hashes only, so deleting the requestId guard can remain green while same-hash refreshes or A→B→A selection render an older result. Fix: Add controlled out-of-order same-hash and A→B→A tests whose named assertions fail when the sequence guard is removed.
30. [REQUIRED] PLAN.md:280,427,589,820 — The 50 MB truncation, 1,000-job cutoff and fallback that drops same-commit flaky detection narrow locked features, but C1–C4 approve none of those reductions. Fix: Preserve the locked behaviour or mark each reduction PENDING-OWNER with its impact and carrying phase.
31. [REQUIRED] PLAN.md:51–52,443,567,765 — The baseline sends builders toward unnecessary or incorrect changes: production construction is in `activation/repositoryMode.ts:256`, persistent none entries last one hour, `CommitCheckState` already includes cancelled/skipped, and Server refs already retain project/repo. Fix: Correct these facts and revise the affected phase scopes before implementation.
32. [MINOR] PLAN.md:305,388,391,802 — C2–C4 are still called PENDING-OWNER and C3’s documentation choice is still described as undecided despite the owner resolutions in the contract table and review log. Fix: Replace stale status language while retaining the recorded decisions and their rationale.
33. [MINOR] PLAN.md:39,436,792 — C1’s claim that fine-grained annotation permissions are undocumented conflates token types, since current documentation specifies Checks read for supported GitHub App tokens. Fix: Correct the provenance and token-type distinction while preserving the owner-approved classic-token guidance and 403 behaviour ([GitHub annotations](https://docs.github.com/en/rest/checks/runs#list-check-run-annotations)).
34. [MINOR] PLAN.md:487–489 — “Users who never open the tab pay nothing new” contradicts the default-on HEAD poller and diagnostics, and the proposed disabled-feature test does not establish that invariant. Fix: State the actual background-request contract and test its budget separately from disabled-feature zero-request behaviour.
35. [MINOR] PLAN.md:138–147 — Failure reporting lacks a defined token-free diagnostic trail for cache hits, discarded generations, exhausted polling and uncertain write outcomes, making a permanently stale display difficult to distinguish from provider failure. Fix: Specify bounded structured logging with operation IDs, repository identity, outcome and retry/cooldown reason, excluding tokens, signed URLs and log contents.
36. [MINOR] PLAN.md:563–582,637–650 — Phases 1 and 5 each combine several substantial implementation and verification boundaries, making them poor single-session units despite the overall 16-phase split. Fix: Split Phase 1 into contracts/cache and provider integration, and Phase 5 into transport/storage and editor/UI integration, with an independently reviewable check at each boundary.

VERDICT: REVISE
### Claude's response (Round 1 triage)

Root spot-checked the CRITICAL claims against code before triage: `normalize.ts:39-42` (failure wins while pending remains), `service.ts:81-82` (force still joins in-flight), `persistentCache.ts:99` (pending never overwrites a settled entry), `.dependency-cruiser.cjs:29-32` (webview may not import `src/services`), `checksRefresh.ts:6-8,26` (finite 8-rung ladder, 20 cap). All confirmed.

- #1 FIXED — separate `complete` (no pending/queued jobs) from `outcome`; cache-immutable, polling stop and toast key on `complete`, never on aggregate `failure`. Test: failed job + running job stays polling until the running job ends.
- #2 FIXED — per-key generation fence; a write action bumps the generation, drops L1 + L2 for that key durably, ignores in-flight results from older generations, and re-enables terminal caching only after a post-action fetch settles.
- #3 FIXED — temp files named `<key>.<pid>.<random>.part`, atomic rename to publish, startup cleanup removes only `.part` files older than 24 h; two-process test.
- #4 FIXED — every request/result carries repoKey + auth generation + lifecycle generation; rechecked after each await and before publishing (webview replies, diagnostics, status bar).
- #5 FIXED — dedup scope = one toast per hash per machine: only the focused window may show it, and the claim is a durable tombstone in `globalState` written before showing; two-host test.
- #6 FIXED — one shared redirect helper for all providers: HTTPS only, max 5 hops, strip `Authorization`/credential headers on any origin change.
- #7 FIXED, with a different fix — the approved design (Figma frame 2:2) shows a log excerpt, so the brief's wording is clarified instead: the full log never enters the webview; a bounded excerpt (≤ 40 lines, ≤ 8 KB, around the first error) may, as escaped text, with hostile-content (HTML, ANSI, bidi) tests. Codex's "remove excerpts" is REJECTED because it drops an approved design element.
- #8 FIXED — annotation paths validated: relative, inside repo root after realpath, no traversal, line ranges clamped; invalid ones dropped and counted, valid ones kept.
- #9 FIXED — capabilities derived from the installed provider at read time; cached enrichment carries a contract version and is ignored on mismatch.
- #10 FIXED — enriched flat-check model (duration, required, usual) and a Server adapter that keeps implemented capabilities.
- #11 FIXED — Phase 1 contracts retain workflow id, check-run id vs Actions job id, and annotation count.
- #12 FIXED — pagination followed at every collection; a bound produces a visible "incomplete" state (bound sizes are owner item #30).
- #13 FIXED — single-pipeline detail request; `FetchJson` gains response headers.
- #14 FIXED — C3 hint shown on 403 from pipeline discovery or step discovery.
- #15 FIXED — dedup by provider identity; name-based join only when unique, else "unknown".
- #16 FIXED — pending-observation set persisted in `workspaceState`; settle during the restart gap still toasts once.
- #17 FIXED — tombstones kept 90 days with no count cap (bounded by age).
- #18 FIXED — HEAD monitoring moves to a host-side monitor (not the webview ladder): back-off capped at 120 s, runs until `complete` while HEAD is unchanged, pauses in rate cooldown, shows "paused" state with a refresh action.
- #19 FIXED — bisect carries loaded hashes + parent links; first-parent walk only inside the loaded set; divergent ranges labelled "not a straight line".
- #20 FIXED — shared attempt-history contract (provider re-run attempts, chronological, deduped) used by tree and bisect.
- #21 FIXED — "previous success" = latest successful run of the same workflow created before the selected run; cache key includes baseline id.
- #22 FIXED — explicit two-revision diff action (`lastGreen` ↔ selected) with tests for add/delete/rename/odd names.
- #23 FIXED — Phase 9 depends on 7; waves regenerated.
- #24 FIXED — shared contracts/constants move to an allowed shared module (e.g. `src/types` or a `src/shared` path the cruiser allows); author verifies against `.dependency-cruiser.cjs`.
- #25 FIXED — cancellation rechecked inside the gated callback before dispatch; test with 4 slots busy.
- #26 FIXED — space reserved atomically before download; refusal message when the cap cannot be kept.
- #27 FIXED — author reads AGENTS.md and restores every required check per phase.
- #28 FIXED — focused VS Code runtime e2e per UI phase, added to the `test:e2e` inventory (proof runs on CI).
- #29 FIXED — same-hash out-of-order and A→B→A tests.
- #30 PENDING-OWNER — 50 MB log cap, 1,000-job cutoff and flaky fallback narrow locked features. Proposed: keep the bounds but each shows a visible "truncated / incomplete" state with Open in browser. Owner decides.
- #31 FIXED — facts corrected after the author re-reads `activation/repositoryMode.ts:256`, the none TTL (1 h, `service.ts:56`), `CommitCheckState`, Server refs.
- #32 FIXED. #33 FIXED. #34 FIXED (state the real background-request contract). #35 FIXED (token-free structured log channel). #36 FIXED (split Phase 1 and Phase 5).

## Round 2 — session reseed

Round 1 SID 01a1b6a6-c0ba-7293-8919-e29165d95b15 telemetry: PEAK=182553 PCT=70% (resumable by policy), but the revised 18-phase plan must be re-read in full, so Round 2 starts a fresh session seeded from PLAN.md + this ledger. #30 resolved by the owner 2026-11-07 (O1 bound + failed jobs always kept; O2 50 MB; O3 estimated fallback). New SID recorded after the run.

SID(old) 01a1b6a6-c0ba-7293-8919-e29165d95b15 -> SID(new) 01a1b6f2-5dd6-79c2-8cf2-9cb7fc4a4708

## Round 2 — Codex (gpt-6-astra, effort xhigh) — FINAL ROUND

Telemetry: PEAK=176870 LAST=176870 PCT=68% NONRESUMABLE=no

All 15 locked features have phase entries. C1–C4 are carried through. O3’s estimated fallback is present; O1 and O2 still have implementation defects.

FIXED-ledger audit: carried #1 (§3), #3 (§5), #6 (K20), #7 (K18), #8 (§11), #10–#11 (§2), #13 (Phases 2–3), #14 (§15), #16 (K27), #18 (§10), #19 (§13–14), #22 (§14), #23 (Phase 11 dependency), #24 (§0), #25 (§13), #27 (Gates L/G/U), #28 (Gate E and runtime specs), #29 (§4), #31 (Current state), #32–#33 (C1–C4), #34 (§10), #35 (§16), and #36 (phase splits). Fixes #2, #4, #5, #9, #12, #15, #17, #20, #21 and #26 remain incomplete as detailed below.

R1 MET — Goal and feature map, PLAN.md:4–32.  
R2 MET — Reference behaviour and visual sources, PLAN.md:34–43.  
R3 PARTIAL — Persistent-storage serialization claim, PLAN.md:55.  
R4 PARTIAL — Log-selection and settled-HEAD journeys, PLAN.md:105–120.  
R5 PARTIAL — Collection completeness, history identity and enrichment contracts, Technical design §§2–5, 9–11.  
R6 PARTIAL — Cross-window claims, cache invalidation and storage recovery, Failure and recovery; §§3, 5, 10.  
R7 PARTIAL — O1 overflow and recovery lack acceptance tests, PLAN.md:659–703; Phases 2, 3, 17.  
R8 MET — Corrected dependencies and regenerated waves, PLAN.md:984–995.  
R9 MET — Per-phase done/review gates and validation sets, PLAN.md:506–533, 718–982.  
R10 PARTIAL — K13 narrows once-per-hash retention without an owner resolution, PLAN.md:553.

1. [CRITICAL] PLAN.md:441–446,592,1032 — FIXED #5 still uses a non-atomic read/write/reread claim, allowing A and B each to write and reread their own tombstone during a focus transfer and both toast. Fix: Use an atomic interprocess claim or single notification owner and test that exact interleaving.
2. [CRITICAL] PLAN.md:155,160,303,388,851 — FIXED #2 still permits stale terminal results because volatility begins after awaited invalidation, disappears on restart, and expires after 120 seconds without evidence that the targeted action took effect. Fix: Establish a durable target-specific action fence before concurrent reads can resume, retain it across restart, and keep unresolved actions visibly unresolved.
3. [CRITICAL] PLAN.md:55,301,719–736 — FIXED #4 does not close the queued-write race because existing `persistentCache.ts:98–118` queues `set` but executes `clear` outside that queue, allowing an old authenticated result to reappear after clearing. Fix: Serialize clear with every persistent read/write and test a generation change while an old write is queued.
4. [CRITICAL] PLAN.md:314–319,967 — The new paginator follows provider-supplied next URLs without an origin/path validation contract, potentially forwarding credentials to another origin and bypassing the existing protection in `bitbucketCloudProvider.ts:229–241`. Fix: Validate every continuation against the authenticated API origin and permitted collection path before dispatch, with hostile-link tests.
5. [CRITICAL] PLAN.md:366,556,823 — Breaking a directory lock solely because it is 30 seconds old allows a paused live owner and its replacement to enter the reservation critical section concurrently. Fix: Specify ownership-safe lock recovery and release, then test a suspended owner resuming after another process acquires the lock.
6. [CRITICAL] PLAN.md:366–367 — Eviction checks only the current window’s `workspace.textDocuments`, so another window can delete a published log while its owner is opening or reading it. Fix: Coordinate pins and publication/read ownership across processes and test eviction during another window’s log open.
7. [REQUIRED] PLAN.md:252,263–274,290–318 — FIXED #12 has no collection-completeness field for capped run lists, annotations or attempts, while `complete` measures execution settlement and therefore allows truncated terminal data to enter immutable caching. Fix: Represent coverage separately at every collection boundary and explicitly govern persistence, refresh and banners without treating truncated data as either fully loaded or still running.
8. [REQUIRED] PLAN.md:153,318,323 — O1’s failed-item overflow scan is unbounded and discards accumulated results when the request gate exhausts its budget, so refreshing can repeatedly restart the same scan without ever reaching later failures. Fix: Preserve continuation progress, pause visibly during cooldown, resume safely with identity checks, and retain all discovered failed items.
9. [REQUIRED] PLAN.md:424,489,767,573 — O1 promises ten pages of 100 items, but several specified requests omit page-size parameters, including GitLab pipeline discovery and GitHub attempt history, whose documented defaults are smaller. Fix: Specify `per_page=100` or the provider’s equivalent at every bounded collection and test actual retained counts and banner text ([GitLab pagination](https://docs.gitlab.com/api/rest/#pagination), [GitHub jobs](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run)).
10. [REQUIRED] PLAN.md:366,369 — O2’s truncation path reserves the entire Content-Length, so a 300 MB log is refused against the 200 MB directory cap instead of yielding the approved 50 MB truncated log, and the truncation marker itself is unreserved. Fix: Reserve the bounded output size including its marker and test oversized known-length and unknown-length responses.
11. [REQUIRED] PLAN.md:157–158,365–366 — A crash can leave reservations consuming the entire directory allowance indefinitely because fresh orphaned `.part` files survive activation and no later timed cleanup is specified. Fix: Add ownership-aware startup and timed reclamation of abandoned reservations, with recovery tests that require no additional restart.
12. [REQUIRED] PLAN.md:443,553,677 — FIXED #17 merely replaces the rejected count cap with a 90-day age cap, allowing the same hash to toast again without an owner-approved limit on “once per hash.” Fix: Retain notification tombstones for the promised scope or obtain an explicit retention decision.
13. [REQUIRED] PLAN.md:281,416,481 — FIXED #15 uses check-run/job execution IDs for cross-commit matching, although those IDs identify different executions on parent and child commits, causing normal history matches to become unknown. Fix: Separate execution identity used for deduplication from logical check identity used across commits, retaining unique-name fallback where stable logical identity is unavailable.
14. [REQUIRED] PLAN.md:261–262,424–428 — FIXED #20 keys attempt history only by check name and deduplicates by attempt number, so same-named jobs in different workflows or pipelines can collapse into one false flaky history. Fix: Scope histories by workflow/pipeline and logical job identity, define provider-specific chronological attempt normalization, and test colliding names and attempt numbers.
15. [REQUIRED] PLAN.md:311,433,452 — Fetching detail only while HEAD is incomplete skips a fresh already-settled HEAD and the final detail refresh when its snapshot settles, leaving final job states, log targets and annotation metadata unavailable or stale. Fix: Require authoritative detail for initial settled failures and settlement transitions before stopping monitoring or publishing dependent results.
16. [REQUIRED] PLAN.md:239,452,572,936–940 — FIXED #9 omits Phase 14 from contract-version bumps even though it populates persisted `annotationCount`, allowing older complete details to advertise annotations while the `annotationCount > 0` guard suppresses every fetch. Fix: Version or explicitly enrich those cached details in Phase 14 and test upgrading with a pre-existing settled cache.
17. [REQUIRED] PLAN.md:112,348–349,837 — The journey promises an excerpt when a failed job is selected, but the only excerpt-producing message is `openCiLog`, which also opens the editor, so the inline preview cannot appear before that click. Fix: Define a separate selected-job preview request or equivalent lazy enrichment path with run/job identity and stale-selection tests.
18. [REQUIRED] PLAN.md:410,337 — Caching the default branch tip by repository and lifecycle generation leaves “also red on main” comparing against an obsolete SHA after an ordinary fetch, because remote-ref changes do not bump that generation. Fix: Resolve the tip on demand or invalidate it on relevant repository/ref changes and test a moving remote tip.
19. [REQUIRED] PLAN.md:563,878 — FIXED #21 specifies a baseline by creation time but queries GitLab with `updated_before`, excluding valid earlier-created pipelines that completed or changed later. Fix: Use the documented `created_before` filter with matching ordering and test an earlier-created pipeline updated after the selected run began ([GitLab pipelines](https://docs.gitlab.com/api/pipelines/#list-project-pipelines)).
20. [REQUIRED] PLAN.md:666,758,771,968 — The acceptance tests never place failed jobs beyond the O1 cutoff, so an implementation that stops at 1,000 and drops the owner’s failure-preservation rule can pass every named pagination test. Fix: Add provider-level overflow fixtures and UI/cache assertions covering later failures, filtered pagination, interruption and resumed scans.


VERDICT: REVISE

### Claude's position (Round 2, deadlock — MAX_ROUNDS reached, handed to the owner)

Code checks: #3 confirmed (`persistentCache.ts:117-119` `clear()` bypasses `enqueue`); #4 confirmed (`bitbucketCloudProvider.ts:229-241` validates next URLs; a generic paginator would bypass it).

- #1 AGREE — replace read/write/reread with an atomic cross-process claim: `fs.mkdir` of a per-hash claim directory under globalStorage.
- #2 AGREE — durable, target-specific action fence in workspaceState, set before the action request; unresolved shows "waiting for re-run to start", no silent 120 s expiry.
- #3 AGREE — route `clear()` through `enqueue`; test generation change with a queued old write.
- #4 AGREE — continuation URLs validated against the provider's API origin and collection path (generalise the Bitbucket check); hostile-link tests.
- #5, #6, #10, #11 AGREE — all four come from the shared on-disk cross-window log store. Owner choice: harden it, or replace it with a per-window in-memory log store (removes the lock, cross-window eviction, reservations and orphan `.part` files).
- #7 AGREE — separate `coverage` (complete / pageBound) from execution `complete`; truncated data never enters the immutable cache as full.
- #8 AGREE — overflow scan for failed items keeps its progress, pauses visibly under the request-gate cooldown, resumes with identity checks; keeps the owner's "always kept" promise.
- #9 AGREE — `per_page=100` (or equivalent) on every bounded collection.
- #12 OWNER — 90-day tombstone retention narrows "once per hash"; Claude recommends keeping 90 days (a toast needs HEAD to move from pending to settled again on that hash).
- #13 AGREE — logical check identity (workflow + job name / pipeline + job name) for cross-commit matching; execution id only for dedup.
- #14 AGREE — attempt history scoped by workflow/pipeline + logical job identity.
- #15 AGREE — fetch detail for a settled failing HEAD and once more on the settlement transition.
- #16 AGREE — Phase 14 bumps the contract version.
- #17 AGREE — separate `previewCiLog` request (excerpt only, no editor open) with run/job identity and stale-selection tests.
- #18 AGREE — resolve the default-branch tip on demand (no lifecycle-generation cache).
- #19 AGREE, VERIFY — use `created_before` if the GitLab docs list it; fall back to `updated_before` plus a creation-time filter client-side.
- #20 AGREE — overflow fixtures with failed jobs past 1 000, filtered pagination, interruption and resume.

## Revision 2 (path C, owner 2026-11-07)

fable-author (opus) applied REVISION-2-BRIEF.md; Root verified 18 phases and C1-C4/O1-O3/K13/K30/K33-K36 rows present, disk-store strings absent; Root replaced the GitLab ASSUMED parameters with docs-verified facts (web lane).

## Round 3 — Codex (gpt-6-astra, effort xhigh) — owner-approved extra round, fresh SID 01a1b72b-b936-79e0-a5ec-59e5d73c2f09

Telemetry: PEAK=184832 LAST=184832 PCT=71% NONRESUMABLE=no

R1 MET — Goal, scope, feature map and next deliverable: PLAN.md:4–32.  
R2 MET — Reference behaviour, visual references and source links: PLAN.md:34–43.  
R3 MET — Current implementation and gap: PLAN.md:45–88; cache and transport claims checked against source.  
R4 PARTIAL — User journeys: restored-log recovery and unresolved-action progress remain incomplete.  
R5 PARTIAL — Technical design: action identity, pagination metadata and history-message contracts need correction.  
R6 PARTIAL — Failure and recovery: action-fence expiry, toast cleanup and final-refresh races remain.  
R7 PARTIAL — Acceptance evidence: the counterexamples below need explicit regression tests.  
R8 MET — Phase dependencies and waves: PLAN.md:831–1121; the declared graph is internally consistent.  
R9 MET — Per-phase done criteria, tests and review gates are present, with shared validation gates at PLAN.md:590–617.  
R10 PARTIAL — K30 labels an unapproved seven-day fence expiry RESOLVED despite the revision brief’s evidence-only clearing rule.

Round 2 audit against the full [rewritten plan](/Users/maheshkokare/PycharmProjects/IntelliGit/docs/superpowers/plans/2026-11-07-ci-checks-tab/PLAN.md):

| R2 finding | Result |
|---|---|
| #1 | Atomic `mkdir` carried at §10/K13; new cleanup race below. |
| #2 | Incomplete: durable storage carried, but expiry and recovery defects remain. |
| #3 | Carried: queued `clear()` and regression test, lines 328, 839–851. |
| #4 | Carried: continuation guard and hostile-link tests, lines 349, 769. |
| #5 | FIXED-BY-REDESIGN: no shared log lock. |
| #6 | FIXED-BY-REDESIGN: no cross-window log eviction. |
| #7 | Partially carried: coverage exists, but completion and flat-list coverage remain incomplete. |
| #8 | Partially carried: cursor preservation exists; cooldown arriving during dispatch remains unspecified. |
| #9 | Carried: explicit page sizes, lines 353–368. |
| #10 | FIXED-BY-REDESIGN: oversized responses truncate, including known Content-Length. |
| #11 | FIXED-BY-REDESIGN: no disk reservations or orphan files. |
| #12 | Owner resolution carried: 90 days, K13. |
| #13 | Partially carried: logical identities exist, but fallback and changed-since-green contracts lose scope. |
| #14 | Carried: histories keyed by `(runId, logicalId)`, provider ordering and collision tests. |
| #15 | Partially carried: both fetches specified, but the final forced fetch can join stale work. |
| #16 | Carried: Phase 14 version bump and upgrade test. |
| #17 | Carried: separate preview message, selection token and no editor opening. |
| #18 | Carried: default-branch tip resolved on demand. |
| #19 | Carried: `created_before`, `order_by=id`, and regression fixture. |
| #20 | Carried: provider overflow, interruption/resume and UI/cache tests. |

All 15 locked features have implementation phases. C1–C4, O2, O3, path C and the 90-day decision are retained. O1’s bounds and failure-preservation intent remain, subject to the coverage and resume defects below.

Round 1 spot-checks retain the completion split, generation guards, redirect stripping, excerpt sanitization, diagnostic containment, capability/version handling, pipeline-detail requests, persisted pending observations, continuing HEAD monitoring, ancestry constraints, scoped attempts, baseline ordering, two-revision diffs, shared-module placement, gated cancellation and validation gates. Findings below qualify the earlier claims that #1, #2, #5, #12 and #15 were fully fixed; #36 remains a size concern.

1. [CRITICAL] PLAN.md §3/K30, lines 330–336 and 654 — Deleting unresolved action fences after seven days reinstates silent expiry and allows the pre-action terminal result to become immutable again without evidence that the action occurred, contradicting R2 #2 and REVISION-2-BRIEF.md. Fix: Remove age-based fence deletion and test reopening after seven days with the provider still returning the old execution.
2. [CRITICAL] PLAN.md §10, line 529 — Two activation sweepers can both identify an expired claim, then one can delete a replacement claim created after the other’s deletion, allowing another toast within the new 90-day retention period. Fix: Coordinate pruning with claim creation so stale cleanup cannot delete a replacement, and test two sweepers with a fresh claim between their deletions.
3. [CRITICAL] PLAN.md §10, line 516 — The settlement fetch uses `force: true` without invalidation, so it can join an older in-flight detail request and stop monitoring with stale job states, matching the verified join behaviour in `service.ts:81–82`. Fix: Require a detail fetch started after settlement, using invalidation or an explicit freshness barrier, and test settlement while a pre-settlement detail request is held.
4. [REQUIRED] PLAN.md §3, lines 330–334 — The retry fence watches the old job ID for an increased attempt or changed state, but GitLab retries create a new job ID, so a completed retry can remain unresolved indefinitely ([GitLab retry semantics](https://docs.gitlab.com/ci/jobs/#retry-jobs)). Fix: Define provider-specific replacement-execution evidence, persist it with the fence, and test GitLab retries that finish before the next poll.
5. [REQUIRED] PLAN.md §3/§6/Phase 4, lines 333–335, 459 and 901 — A fenced result may still be `complete`, which stops the specified polling after the single post-action fetch and leaves neither automatic resolution nor the ten-minute label update guaranteed. Fix: Define fence-driven polling and a not-seen timer independent of execution completion, including restart and cooldown tests.
6. [REQUIRED] PLAN.md §5, lines 441–445 — After reload creates an open placeholder document, downloading the log and opening the same URI leaves that placeholder visible because VS Code reuses an already-open document ([VS Code API](https://code.visualstudio.com/api/references/vscode-api#workspace.openTextDocument)). Fix: Fire the content provider’s `onDidChange` when a successful load replaces placeholder/error content, and test reload → placeholder → Open full log → actual text.
7. [REQUIRED] PLAN.md §3/Phase 5, lines 347–348, 387–389 and 932–934 — The ETag store retains only body and ETag, so a valid 304 lacking `Link` or `x-next-page` loses pagination metadata and can make a later-page failure disappear behind falsely full coverage ([HTTP 304 semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-304-not-modified)). Fix: Retain and restore pagination metadata with the cached representation while observing fresh response quota headers, and test a multi-page 200 followed by a header-minimal 304.
8. [REQUIRED] PLAN.md §3, lines 375–378 — Checking cooldown before dispatch does not cover cooldown or budget exhaustion arising while queued, which `requestGate.ts:223–235` can throw after acquisition and the plan currently classifies as a stopped page failure. Fix: Classify those gate failures as paused, retain the cursor and found items, schedule automatic resume, and test cooldown beginning after the precheck.
9. [REQUIRED] PLAN.md §3/§10, lines 315 and 515–524 — Computing completion solely from returned items can declare all work finished when a capped run collection hides a queued or running execution, despite its non-full coverage. Fix: Require authoritative completion evidence or represent settlement as unknown, and test a pending execution beyond the collection bound against monitor stopping and toast emission.
10. [REQUIRED] PLAN.md §2/Phase 18, lines 285–310 and 1103 — `otherChecks` has no collection-coverage field, so the Server adapter cannot expose truncation from its existing five-page reader and `isFullyCovered` can accept a partial flat detail as whole. Fix: Add flat-collection coverage to the contract, persistence predicate and UI, with a fixture exceeding the reader’s bound.
11. [REQUIRED] PLAN.md §9, lines 493–499 — The name fallback requires uniqueness only in the parent, allowing a newly added same-named job in another workflow to inherit the existing workflow’s history. Fix: Require an unambiguous match in both current and parent populations within the applicable scope, otherwise return unknown, and test two current workflows against one parent name.
12. [REQUIRED] PLAN.md §4/§14, lines 417–418 and 565 — `requestChangedSinceGreen` carries only `checkName`, losing the selected job’s logical identity and making same-named jobs in different workflows impossible to distinguish. Fix: Carry the selected logical identity and required scope through request, reply and ancestor lookup, and test workflows with different last-green commits.
13. [MINOR] PLAN.md Phase 1, lines 831–861 — Phase 1 again combines shared contracts, two cache implementations, durable actions, generations, tracing, provider declarations and polling changes into one large builder session despite Round 1 #36. Fix: Split or explicitly stage these at independently reviewed integration boundaries.

VERDICT: REVISE

### Claude's position (Round 3)

Code check: #3 confirmed (`service.ts:81-82` joins any in-flight fetch even with `force`). #1 confirmed: PLAN.md:336 added a 7-day fence expiry that REVISION-2-BRIEF.md did not ask for.

- #1 AGREE — drop the 7-day deletion; a fence ends on evidence, or when the user clicks Refresh on a "not seen yet" target (the user's own evidence).
- #2 AGREE — simplest correct fix: never prune toast claims (empty directories, one per settled HEAD hash), so no sweeper exists to race. Reverses the owner's 90-day retention toward the stronger "once per hash" promise — owner to confirm.
- #3 AGREE — `invalidate(hash)` before the settlement fetch, so it never joins pre-settlement work; test with a held pre-settlement request.
- #4 AGREE — GitLab retry evidence: a newer job with the same logical id in the same pipeline; stored with the fence.
- #5 AGREE — while a fence exists, the item polls on the pending ladder regardless of completion; the 10-min label is driven by a timer; restart and cooldown tests.
- #6 AGREE — content provider fires `onDidChange` when a load replaces placeholder text.
- #7 AGREE — the ETag entry stores the pagination headers with the body and restores them on 304.
- #8 AGREE — gate cooldown or budget failure after acquisition = paused (cursor kept, auto-resume), not stopped.
- #9 AGREE — non-full run coverage makes settlement unknown: the monitor keeps polling and no toast fires.
- #10 AGREE — flat `otherChecks` gets coverage; Server five-page reader reports truncation.
- #11 AGREE — name fallback needs a unique match in both current and parent populations, else unknown.
- #12 AGREE — `requestChangedSinceGreen` carries the logical id and scope.
- #13 MINOR, AGREE — move the action fence out of Phase 1 into its own phase depending on Phase 1.
