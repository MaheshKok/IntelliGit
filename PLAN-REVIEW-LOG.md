# Plan Review Log: Visual + E2E testing on a dedicated fixture repository

Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5. Reviewer: gpt-5.6-sol (per-round effort schedule per claudex-review).

**Act 3 builder override (Mahesh, mid-Act-2):** implementation goes to an in-harness **Sonnet 5** Builder at **xhigh** reasoning, not to Codex/`claudex-build`. Stated as a one-off for this plan ("this time"), so it is not recorded as a standing preference. Acts 1 and 2 are unaffected — Codex remains the adversarial plan reviewer for every round. Claude remains spec-owner, diff reviewer, and integrator; the review loop over the Builder's diff is unchanged in kind, only the builder model differs.

Kickoff snapshot: `main` clean at `4cc864c0` (== origin/main). `PLAN.md` and `PLAN-REVIEW-LOG.md` were tracked and clean at kickoff (previous cycle: marketplace review prompt, shipped in 0.24.0), so both are eligible for the Act-2→build plan-checkpoint commit.

Grill decisions (Mahesh, 8 questions):

1. **Test layers** — both, staged: Layer 1 webview visual regression + Layer 2 real-VS-Code E2E on a real fixture repo.
2. **Fixture repo** — seed script → template built once → `git clone --local` per test; reset = discard clone and re-clone. (Rejected: checked-in `.bundle`; a real GitHub repo.)
3. **"Upstream" disambiguation** — meant **baseline re-approval policy**, not the git remote. The fixture's bare `origin` is still required for push/pull/publish flows and was taken as a design detail, not a question.
4. **Baselines** — committed PNGs, generated only inside a pinned Playwright Docker image, updated only via an explicit `test:visual:update`; CI never self-heals.
5. **Layer 2 driver** — Playwright `_electron` on a pinned `@vscode/test-electron` binary. (Rejected: `wdio-vscode-service` = a third runner; in-host Mocha = no clicks, no screenshots.)
6. **E2E scope** — tiered: ~10 critical mutating flows on PR, all 42 nightly + release tags, sharded. (69 contributed commands, 42 mutating — counted from `package.json`.)
7. **Unit tests** — for the new test infrastructure itself (seed determinism, reset completeness, isolation, protocol conformance, harness drift). (Rejected: React component backfill as duplicate of Layer 1 in a weaker medium.)
8. **Visual matrix** — dark + light × 2 viewports (narrow sidebar / wide undocked) = 4 baselines per screen; high-contrast and the 12 locales get non-pixel assertions (overflow, contrast ratio, target size).

Codebase evidence gathered during the grill (Gate 2):

- Webviews build to 7 IIFE bundles via [scripts/webviewConfigs.js:3](scripts/webviewConfigs.js:3).
- All seven share one HTML shell, [webviewHtml.ts:61](src/views/webviewHtml.ts:61), which sets exactly two bootstrap globals (`window.intelligitSettings`, `window.intelligitI18n`) plus `#root` — this is what the Phase 3 harness must mirror and the Phase 6 drift guard must assert.
- `acquireVsCodeApi` is acquired in exactly one place, [vscodeApi.ts:29](src/webviews/react/shared/vscodeApi.ts:29) — a single stub point for Layer 1.
- [scripts/preview-merge-editor.js](scripts/preview-merge-editor.js) already serves a built webview bundle to a plain browser with a stubbed `acquireVsCodeApi` — the Layer 1 harness generalizes it rather than inventing one.
- Deterministic-SHA git fixtures already exist at [rebaseTestHarness.ts:26](tests/integration/rebase/rebaseTestHarness.ts:26) (frozen `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`); Phase 1 reuses that technique.
- Existing suite: 168 test files, vitest + jsdom, coverage floor 88.5% lines. 38 webview tests against 122 webview source files.
- CI is a single ubuntu-latest job on bun; no display server today, so Layer 2 needs `xvfb-run`.

---

## Round 1 — Codex (gpt-5.6-sol, effort ultra)

SID: `019fd631-83f4-70c2-b072-46840f1d4749`. Telemetry (rollout; the `--json` stream carried no usage events): `EVENTS=69 PEAK=200234 LAST=200234 PCT=77% NONRESUMABLE=no`.

20 findings — 6 CRITICAL, 14 REQUIRED, 0 MINOR.

1. [CRITICAL] Phase 1 steps 4–5 — A normal `git clone` does not reproduce the source index, tracked dirt, untracked/ignored files, local config, local branches, or all private refs, so dirty/discard tests can start clean and pass as no-ops. Fix: Deterministically hydrate and snapshot every clone after cloning, and mirror the private bare origin explicitly.
2. [CRITICAL] Phase 6 step 26 — "Fresh clone is unaffected" tests isolation only and still passes when the fresh clone starts wrong or `dispose()` leaks the old clone, origin, profile, process, or external worktree. Fix: Assert the canonical initial snapshot and verify every allocated resource is gone after both successful and failing teardown.
3. [CRITICAL] Phase 3 steps 11–12 / `src/views/webviewHtml.ts` — The proposed shell and drift guard omit production reset/font/background/reduced-motion CSS, `<html lang>`, per-view backgrounds, and required merge/conflict stylesheet links, allowing baselines for a non-production layout to pass. Fix: Encode every bundle's shell options and compare normalized production and harness HTML, styles, attributes, and assets.
4. [CRITICAL] Phase 0 step 2 / Phase 3 step 13 — `document.documentElement.style.cssText` omits VS Code's body theme classes and datasets, while `shikiHighlighter.ts` reads those classes directly, so dark merge-editor baselines can silently render light syntax colors. Fix: Capture and replay root CSS plus body classes and theme datasets as one versioned fixture.
5. [CRITICAL] Phase 6 step 28 / `tsconfig*.json` — Vitest transpiles tests without type-checking and both current TypeScript projects exclude `tests`, so interface-only protocol conformance assertions cannot fail in CI. Fix: Add a fixture-specific `tsc --noEmit` project to `typecheck` or use executable exact runtime validators.
6. [CRITICAL] Phase 4 step 21 — UI, local-Git, and lock assertions can all pass while the private origin or shelf/rebase durable state is wrong because neither `originRoot` nor global-storage state is required as an oracle. Fix: Define per-flow oracles covering the bare origin or fresh collaborator, shelf/rebase storage, and exact `repo.lock`/`takeover-*` absence.
7. [REQUIRED] Phase 1 steps 4 and 7 / `src/shelf/paths.ts` — A template shelf is unusable because production stores shelves under global storage keyed by a hash of each clone's absolute real path, and every test gets a fresh path and profile. Fix: Seed deterministic shelves after allocating the clone/profile into that clone's resolved production shelf path and assert they render.
8. [REQUIRED] Phase 1 step 4 / Phase 6 step 25 — Fixed identity and dates cover seed commands only; extension- or recorder-created commits, merges, rebases, and stashes still inherit current time and user/system Git configuration, while clone-local config is regenerated. Fix: Sanitize Git configuration and dates for every Git process, reapply clone config, and compare representative post-clone mutation SHAs across hostile environments.
9. [REQUIRED] Phase 1 step 6 — Reset enumeration omits reachable state including `FETCH_HEAD`, `ORIG_HEAD`, `REBASE_HEAD`, `AUTO_MERGE`, merge/squash messages, `sequencer/`, rerere data, `$GIT_COMMON_DIR/intelligit/*`, external worktree directories, bare-origin HEAD/reflogs, and VS Code workspace/global state. Fix: Define a domain-based canonical snapshot with an explicit exclusion rationale for every unreachable state.
10. [REQUIRED] Phase 2 steps 8–10 — Real payloads contain random absolute roots, UUID-based shelf/session IDs, and `Date.now()` values, so re-recording can produce nondeterministic JSON and screenshots despite stable Git SHAs. Fix: Inject fixed clocks/IDs, canonicalize environment paths, and add a record-twice byte-equality test.
11. [REQUIRED] Phase 0 step 2 / Phase 3 step 13 — The spike captures only one unspecified active theme, yet later claims both dark and light fixtures, and a version-only staleness check accepts the wrong theme or profile. Fix: Select explicit built-in theme IDs in fresh profiles and record host commit, platform, theme ID/kind, and capture schema.
12. [REQUIRED] Phase 3 steps 13 and 16 — Only dark/light theme fixtures are defined, so high-contrast assertions have neither high-contrast tokens nor the host classes needed to exercise that axis. Fix: Capture and replay fixed high-contrast-dark and high-contrast-light host fixtures for the non-pixel suite.
13. [REQUIRED] Phase 3 step 17 / Risk R2 / Phase 4 step 23 — A mutable `v<X>-jammy` tag plus a Linux-only assertion permits baseline updates and CI comparisons outside the intended environment. Fix: Pin one image digest and require matching image, browser, OS, and font-manifest metadata for both updates and CI comparisons.
14. [REQUIRED] Phase 0 step 2 / Phase 4 step 23 — `dist/` is ignored and `package.json` launches `dist/extension.js`, but neither the spike nor the new parallel jobs build or download the extension/webview bundles. Fix: Add an explicit verified build step or immutable build artifact before every launch and visual-server start.
15. [REQUIRED] Phase 4 steps 20–21 — The static seed does not establish flow-specific prerequisites such as a collaborator-created remote commit, rewritten history, a stale lease, or a live operation to abort, allowing the named action to exercise a guard or no-op instead. Fix: Add a setup/action/UI/local/origin/durable-state matrix for every PR and nightly flow.
16. [REQUIRED] Phase 4/5 steps 20 and 24 — The "42 mutating commands" count is not encoded, includes color aliases and duplicate handlers, and excludes mutating webview actions such as commit, so nightly completeness cannot be audited or kept current. Fix: Check in a canonical command/action-to-scenario manifest with alias mapping and test it against contributions and registered handlers.
17. [REQUIRED] Phase 5 step 24 — Layer 1 runs plain Chromium with committed fixtures and never launches VS Code, so running it "against VS Code Insiders" changes no tested input. Fix: Feed it freshly captured Insiders host artifacts or add an Insiders host compatibility probe that actually loads the bundles.
18. [REQUIRED] Phase 5 step 24 / `.github/workflows/publish.yml` — The release job depends only on `build` and tags immediately on a main push, so a separate scheduled failure cannot block that tag. Fix: Require same-SHA nightly attestation or equivalent E2E/visual gates before tag creation.
19. [REQUIRED] Phase 6 steps 25–31 — No test proves the overflow, size, contrast, theme-replay, or server-selection oracles reject known-bad inputs, so inverted or no-op assertion code can remain green. Fix: Add known-failing harness fixtures for clipping, overlap, transparency, zero-size targets, wrong themes, and invalid routing.
20. [REQUIRED] Risk R3 — Masking the canvas and checking only numeric lane geometry removes coverage of actual paint, colors, scaling, clipping, and compositing. Fix: Require a deterministic targeted canvas-render oracle before permitting any mask.

VERDICT: REVISE

### Claude's response

Independent verification first — six of Codex's factual claims were checked against the repository before triage, and all six held:

| Claim | Verified |
|---|---|
| #4 webviews read body theme classes | `src/webviews/react/merge-editor/shikiHighlighter.ts:68` (`classList.contains("vscode-dark")`), `src/webviews/react/shared/theme.ts:10` |
| #5 tests are never type-checked | `tsconfig.json` `"exclude": [… "tests"]`; `tsconfig.webview.json` includes only `src/webviews/react/**` |
| #7 shelf storage keyed by path hash | `src/shelf/paths.ts:31-32` — `realpath` → sha256 → 16-char repoId |
| #14 `dist/` is git-ignored | `.gitignore:146` |
| #16 command count inflated by aliases | 69 contributed, **8** `.color` aliases, 61 unique bases — the "42 mutating" figure was regex-derived and wrong |
| #18 release cannot be gated by a schedule | `.github/workflows/publish.yml:122-123` — `release: needs: build`, tag created on main push |

Disposition — **19 FIXED, 1 partially rejected**:

- **#1 FIXED, but with a different fix than proposed.** Codex proposed hydrating and snapshotting each clone after cloning. That patches the symptom and leaves the clone semantics as a permanent trap for future fixture state. The restore primitive is instead replaced outright: a **recursive byte-exact directory copy of the template** (working repo + bare origin, with the origin URL rewritten and clone-local config reapplied and asserted). This is strictly simpler and eliminates the defect class rather than compensating for it. Recorded as new risk **R6** (copy cost); the stated mitigation if it ever dominates is a smaller template, never a return to cloning.
- **#2 FIXED** — restore fidelity now asserts the canonical initial snapshot item-by-item (step 33), and resource cleanup is a separate test covering both successful and failing teardown, including linked worktrees and spawned processes (step 34).
- **#3 FIXED** — a checked-in table encodes all 7 bundles' real shell options; the drift guard compares normalized production vs harness HTML including `lang`, inline style block, background, and the full asset list (steps 15–16, 38).
- **#4 FIXED** — the capture is now a "host fixture": root CSS vars **plus** `html`/`body` class lists and datasets, with provenance (steps 4–5).
- **#5 FIXED** — `tsconfig.tests.json` added to the `typecheck` script, **plus** runtime validators, so the oracle can actually go red (step 36).
- **#6 FIXED** — oracles are now four-way: UI, local git, bare origin (or a fresh clone of it), durable extension state including exact lock-residue absence (step 24).
- **#7 FIXED** — shelves are seeded *after* workspace and profile allocation, into that workspace's resolved production shelf path via the real `ShelfService`, with a render assertion (step 10).
- **#8 FIXED** — sanitized git environment (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`, scratch `HOME`, fixed identity + dates) extended to the extension's own subprocesses and the recorder; determinism re-asserted under a hostile ambient environment (steps 7, 32).
- **#9 FIXED** — step 9 is now a domain-based canonical snapshot naming every item Codex listed, with a written rationale for anything excluded.
- **#10 FIXED** — injected clock and deterministic ID source, path canonicalization, record-twice byte-equality test (steps 12, 37).
- **#11 FIXED** — explicit built-in theme IDs in fresh profiles; provenance records VS Code version **and commit**, platform, theme ID/kind, schema version (steps 5, 39).
- **#12 FIXED** — `hc-black` and `hc-light` host fixtures captured, without which the high-contrast non-pixel assertions had nothing to assert against.
- **#13 FIXED** — image pinned by digest; image/browser/OS/font-manifest match required on update **and** compare (step 20, R2).
- **#14 FIXED** — verified build gate promoted to step 2, binding on every launch, CI job, and harness-server start.
- **#15 FIXED** — flows are rows in a `setup → action → UI/local/origin/durable` matrix; setups include a collaborator commit, rewritten history, a stale lease, and an in-flight operation (step 23).
- **#16 FIXED** — the number is removed from the plan and replaced by a checked-in coverage manifest with alias collapsing, extended to cover webview-only mutating actions, asserted exhaustive against contributions **and** registered handlers (step 28).
- **#17 FIXED** — the claim was incoherent as written and is corrected: Insiders early-warning attaches to Layer 2; Layer 1 gets it only via freshly captured Insiders host fixtures diffed against the pinned ones (step 30).
- **#18 FIXED** — the plan's claim that nightly red blocks the release tag was false against the actual workflow. Nightly now publishes a same-SHA attestation and the release job requires it, with a documented `workflow_dispatch` override (step 31).
- **#19 FIXED** — every oracle gets a known-bad fixture that must fail: clipped label, overlapping control, zero-size target, transparent-on-transparent, dark bundle against light host fixture, invalid harness route (step 40). Promoted to a governing principle in the Goal.
- **#20 PARTIALLY REJECTED.** Accepted: a bare mask silently deletes real coverage, so R3 now forbids applying one without shipping a replacement oracle in the same change. Rejected: building a deterministic canvas-render oracle *before* any flake is observed. R3 is a contingency — software rasterization is already forced — and pre-building an oracle for a problem that may not occur is speculative work. If canvas flake materializes, the oracle becomes mandatory at that moment.

---

## Round 2 — Codex (gpt-5.6-sol, effort xhigh)

Resumed `019fd631-83f4-70c2-b072-46840f1d4749`. Telemetry: `EVENTS=100 PEAK=206524 LAST=128142 PCT=79% NONRESUMABLE=no`.

8 findings — 4 CRITICAL, 4 REQUIRED, 0 MINOR (down from 20).

1. [CRITICAL] Phase 6, step 40 — The negatives omit step 24's UI/local/origin/durable oracles, steps 33–35's snapshot/cleanup/isolation oracles, step 36's compile-time inclusion, and step 19's opaque low-contrast case, so no-op implementations can still pass. Fix: Add a checked-in oracle-to-known-bad matrix with an expected-failure test for every oracle.
2. [CRITICAL] Risks / open questions — Allowing the coverage manifest to warn for one release contradicts step 28's exhaustiveness assertion and permits an unmapped mutating handler to land with green CI. Fix: Make unmapped commands and webview actions hard failures from the manifest's first enforced run.
3. [CRITICAL] Phase 1, step 9 — The snapshot omits `$GIT_COMMON_DIR/worktrees/<id>` private state, complete refs/object stores and alternates, and bare-origin config/object integrity, so corrupt or template-dependent copies can compare green despite Git storing linked-worktree administration there. Fix: Snapshot all refs and per-worktree state, assert contained-or-absent alternates, and verify both repositories with complete object inventories and `git fsck`.
4. [CRITICAL] Phase 3, step 19 / src/webviews/react/merge-editor/merge-editor.css — `scrollWidth <= clientWidth` cannot detect vertical clipping and rejects the repository's intentional ellipsis, producing both silent locale false-greens and false-reds. Fix: Check both dimensions only on declared non-truncatable visible elements, and separately verify accessible full text for intentional ellipsis.
5. [REQUIRED] Phase 1, steps 9–10 — "Workspace/global state" excludes the `globalStorageUri` files holding shelves and rebase manifests and the `context.secrets` mutated by contributed sign-in/sign-out commands. Fix: Include IntelliGit global-storage files, both Memento stores, and test-only SecretStorage contents in the canonical snapshot and durable-state oracle.
6. [REQUIRED] Phase 1, step 8 — Recursive copying is not byte-exact by construction because symlink text, modes, timestamps, special files, and inode separation have no defined contract, while the required origin rewrite deliberately changes copied bytes. Fix: Specify copier options, canonicalize `<ROOT>/<ORIGIN>/<PROFILE>`, inventory type/mode/link-target/digest, and assert no regular file is hardlinked to the template.
7. [REQUIRED] Phase 6, step 32 — Equal SHAs, raw logs, and tree hashes do not prove determinism of ignored/untracked bytes, index flags and stages, stash/reflogs/config, bare-origin state, or post-allocation shelf state. Fix: Compare normalized step-9 canonical snapshots from two independently seeded and fully initialized workspaces under the hostile environment.
8. [REQUIRED] Phase 5, step 31 / .github/workflows/publish.yml — A version-changing push runs `release` before its same-SHA nightly attestation exists, and later nightly success does not retrigger that workflow, leaving no automatic attested release path. Fix: Trigger release from successful same-SHA attestation completion or explicitly invoke and await the full sweep before the release job.

VERDICT: REVISE

### Claude's response

Verified before triage — all three repo-specific claims held:

| Claim | Verified |
|---|---|
| #4 intentional ellipsis exists | 5 × `text-overflow: ellipsis` across `merge-editor.css` and `merge-conflicts-session.css` — the naive check would false-red on every one |
| #5 SecretStorage is mutated | `context.secrets` at `repositoryMode.ts:214` (`CredentialStore`), `repositoryCommands.ts:203`, `noRepositoryMode.ts:157`, `commitChecksAuthCommands.ts:24`; plus `globalState`/`workspaceState` throughout |
| #3 worktree admin state is load-bearing | `src/git/executor.ts:105` and `src/git/repositoryMutationGate.ts:14` perform common-dir–scoped locking |

Disposition — **7 FIXED, 1 FIXED with a scope limit**:

- **#1 FIXED** — step 40 replaced by a checked-in oracle registry (`tests/oracles.ts`) with a meta-test asserting every registered oracle has an expected-failure fixture. Now covers the four-way flow oracles individually (one fixture corrupting each leg), restore fidelity, resource cleanup incl. a throwing teardown, isolation via a deliberately hardlinked copy, both halves of protocol conformance, the opaque low-contrast case, and the wrong-body-class host fixture.
- **#2 FIXED** — the open question is deleted, not answered both ways. The manifest hard-fails on an unmapped command or webview action from its first enforced run; the map is filled in *before* the check is enabled. Codex was right that leaving this open contradicted step 28 in the same document.
- **#3 FIXED, with one scope limit.** Added: `$GIT_COMMON_DIR/worktrees/<id>/` admin state, exhaustive `for-each-ref` enumeration, index flags and unmerged stages, object inventory, and an alternates contained-or-absent assertion — for both the workspace and the bare origin. **Scope-limited:** `git fsck` runs on the template once per suite and inside the Phase 6 harness tests, *not* on every per-test copy. Per-test `fsck` across hundreds of copies buys corruption detection the inventory + digest comparison already provides, at a cost the PR tier cannot absorb. Recorded as a deliberate limit, not an oversight.
- **#4 FIXED** — the naive check is removed outright. Non-truncatable elements are checked in **both** dimensions; truncatable elements are exempt from overflow and instead assert their full text is reachable via `title`/`aria-label`. This fixes the false-red and the vertical-clipping blind spot together.
- **#5 FIXED** — step 10 now names three stores explicitly: `globalStorageUri` files (shelves, rebase manifests), both Memento stores (`globalState`, `workspaceState`), and `context.secrets` via `CredentialStore`, with test-only credentials for the sign-in/sign-out flows.
- **#6 FIXED** — the "byte-exact by construction" claim is withdrawn as an overclaim. Step 8 now pins copier options (`recursive`, `force`, `preserveTimestamps`, `dereference: false`, `verbatimSymlinks: true`), defines the canonical `<ROOT>`/`<ORIGIN>`/`<PROFILE>` placeholders, records a type/mode/link-target/digest inventory, asserts no regular file shares an inode with the template, and asserts a post-copy diff shows *only* declared rewrites. New risk **R7** tracks drift in that rewrite set.
- **#7 FIXED** — step 32 now compares normalized step-9 canonical snapshots from two independently seeded and **fully initialized** workspaces (copy + profile + shelves), under the hostile ambient environment.
- **#8 FIXED** — the v2 attestation design had a real ordering hole: `release` runs before any same-SHA nightly exists, and a later nightly never retriggers it. Corrected by separating purposes — the **nightly gates nothing** (early warning, opens an issue), and the release gate is a same-SHA `e2e-full` job that `release` declares in `needs:`. The gate therefore always exists when the release runs, with no retrigger requirement.

---

## Round 3 — Codex (gpt-5.6-sol, effort xhigh)

Resumed `019fd631-83f4-70c2-b072-46840f1d4749`. Telemetry: `EVENTS=129 PEAK=206524 LAST=54976 PCT=79% NONRESUMABLE=yes` — **compaction detected** (`LAST` under half of `PEAK`). Per session hygiene this session is retired after this round; Round 4 reseeds a fresh one from `PLAN.md` + the ledger.

11 findings — 2 CRITICAL, 8 REQUIRED, 1 MINOR.

1. [CRITICAL] Phase 6, step 40 — The registry meta-test is self-referential: omitting an oracle from the registry still passes, and the listed negatives already omit a UI-wrong flow fixture, the pixel comparator, determinism checks, shell/host drift guards, and baseline hygiene. Fix: Define an independent exhaustive oracle catalogue or require every oracle consumer to resolve through the registry, then add the missing expected-failure fixtures.
2. [CRITICAL] Phase 3, step 19 — An element whose own scroll dimensions fit still passes when an ancestor or viewport clips it, producing a silent false-green for text visibility. Fix: Intersect rendered text-range bounds with the viewport and every clipping ancestor, and register a parent-clipping known-bad fixture.
3. [REQUIRED] Phase 1, steps 9–10 — The snapshot omits two stores this extension actually mutates: global VS Code configuration such as `intelligit.undockableWindow` and persisted webview state written through `setState`. Fix: Include all configuration scopes and each webview's persisted state in the canonical snapshot and durable-state oracle.
4. [REQUIRED] Phase 1, step 9 / `src/git/interactiveRebase/guards.ts` — The named worktree inventory omits real private state including `commondir`, `config.worktree`, `FETCH_HEAD`, `COMMIT_EDITMSG`, and per-worktree logs, while the main repository inventory also omits `BISECT_*` state that IntelliGit explicitly probes. Fix: Recursively inventory every resolved worktree Git directory and common directory with a narrowly documented exclusion list.
5. [REQUIRED] Phase 1, step 8 — The rewrite contract conflates live rehydration with canonical comparison by saying functional Git paths are replaced on disk with `<ROOT>`, `<ORIGIN>`, and `<PROFILE>`, which are not usable paths. Fix: Rewrite live metadata to concrete per-test paths and apply placeholders only while normalizing inventories and diffs.
6. [REQUIRED] Phase 1, step 8 / Risk R7 — With `dereference: false` and verbatim symlinks, an absolute or escaping relative symlink passes the inventory and post-copy diff while still targeting the template or another external path. Fix: Reject escaping links or rebase template-contained absolute targets, assert every resolved link remains inside declared roots, and test that writing through a copied link cannot alter the template.
7. [REQUIRED] Phase 1, steps 7–10 and Phase 6, step 34 — Cleanup does not own the scratch `HOME` or the `intelligit-*` directories that the extension creates under the process-wide OS temp directory, so interrupted flows can leak mutable state outside every reset target. Fix: Allocate per-test `HOME`, `TMPDIR`, `TMP`, and `TEMP` beneath fixture-owned roots and include them in snapshots, teardown assertions, and a throwing-teardown negative fixture.
8. [REQUIRED] Phase 3, steps 19 and 40 — A truncatable element without `title` or `aria-label` is not necessarily inaccessible because its full computed name can come from DOM content, `aria-labelledby`, or a native label, making the proposed known-bad fixture invalid. Fix: Assert the computed accessible name or accessibility-tree text equals the untruncated source instead of requiring specific attributes.
9. [REQUIRED] Phase 5, step 31 / `.github/workflows/publish.yml` — Adding `e2e-full` to `needs` causes GitHub to skip `release` after an E2E failure, so the promised dispatch override is not implemented, while the existing `force_publish` input bypasses only version comparison. Fix: Specify a separate audited dispatch-only E2E override and an explicit job condition.
10. [REQUIRED] Phase 5, step 31 / `.github/workflows/publish.yml` — Because the workflow also triggers on `pull_request`, an unguarded `e2e-full` job would run the complete sweep on every PR and defeat the settled PR tier. Fix: Restrict `e2e-full` to main-branch pushes and manual dispatches while keeping the critical-flow job as the PR dependency.
11. [MINOR] Phase 1 introduction and Key decisions table — Both still call the restore primitive "byte-exact by construction" despite step 8 explicitly withdrawing that claim. Fix: Describe it consistently as a contract-checked recursive copy equivalent modulo declared live rewrites.

VERDICT: REVISE

### Claude's response

Verified before triage — all four repo-specific claims held, and one is larger than reported:

| Claim | Verified |
|---|---|
| #4 BISECT is probed | `src/git/interactiveRebase/guards.ts:100` runs `git bisect log` and uses its exit status as the probe |
| #3 global config + webview persistence | `src/activation/repositoryMode.ts:1154` — `config.update("undockableWindow", true, true)`, third arg = **global** scope; `setState` at 10+ webview sites |
| #7 OS-temp leakage | **Larger than stated: 9 sites in `src/`** — `gitAskpass.ts:54`, `shelfService.ts` ×3, `shelfServiceCapture.ts:51`, `shelfConflictSession.ts` ×2, `operations.ts:984`, `patchApplication.ts:18` |
| #9/#10 CI shape | `.github/workflows/publish.yml` triggers on `pull_request` as well as `push`; existing jobs already carry explicit `if:` guards (lines 107, 125) |

Disposition — **11 FIXED**. All eleven were correct; four were verified independently rather than taken on assertion. No finding was rejected this round. (Standing rejections from earlier rounds remain in force: R1 #20's speculative canvas oracle, and R2 #3's per-test `git fsck` scope limit.)

- **#1 FIXED** — the self-reference is broken structurally rather than by adding more entries: oracles are consumed **only** via `oracles.get(id)`, with a lint rule forbidding direct imports of oracle implementations, so an unregistered oracle is unusable rather than merely unaudited. Added the missing fixtures: UI-wrong flow leg (now five, not four), pixel comparator, seed/recorder determinism, shell drift, host staleness, baseline hygiene, symlink containment, inode separation, scratch-directory ownership.
- **#2 FIXED** — the oracle now intersects rendered text-range rects with every clipping ancestor's content box and the viewport; parent-clipping known-bad fixture registered.
- **#3 FIXED** — step 10 gains all configuration scopes (explicitly including global-scope `update`) and per-webview `setState` persistence.
- **#4 FIXED** — the include-list is inverted to a **recursive walk with a documented exclusion list**, which is exhaustive by construction; `BISECT_*` called out explicitly because `guards.ts` refuses rebase mid-bisect, so a leaked session changes later-test behaviour.
- **#5 FIXED** — a genuine error in my own wording. Live rehydration writes **concrete per-test absolute paths**; the `<ROOT>`/`<ORIGIN>`/`<PROFILE>` placeholders are comparison-only and never touch the filesystem. A repo containing the literal `<ROOT>` would not function.
- **#6 FIXED** — symlink containment: every resolved target must land inside the declared roots, template-contained absolute targets are rebased, anything escaping is rejected at copy time, and a test writes through a copied link to assert the template is unchanged.
- **#7 FIXED** — each test allocates `HOME`, `TMPDIR`, `TMP`, `TEMP` beneath its own fixture-owned root; these enter the snapshot, `dispose()`, and the teardown assertions including the throwing-teardown fixture.
- **#8 FIXED** — attribute-presence replaced by a **computed accessible name** comparison against the untruncated source, which also catches the case Codex implied but did not state: a name that is present but itself truncated.
- **#9 FIXED** — `needs:` alone would make GitHub *skip* `release`, so the override never existed. Now `needs: [build, e2e-full]` plus an explicit `always()`-based `if:` requiring `build` success and `e2e-full` success unless a separate audited `skip_e2e_gate` dispatch input is set.
- **#10 FIXED** — `e2e-full` restricted to main-branch pushes and manual dispatches. Unguarded, it would have run the full sweep on every PR and destroyed grill decision #6 (the settled ~10-flow PR tier) from inside the plan meant to implement it.
- **#11 FIXED** — "byte-exact by construction" removed from the Phase 1 heading, the v2 change note, and the Key decisions table; consistently "contract-checked recursive copy, equivalent modulo declared live path rewrites".


---

## Round 4 — `gpt-5.6-sol` @ `xhigh` — 10 findings (4 CRITICAL, 5 REQUIRED, 1 MINOR) — `VERDICT: REVISE`

**Session reseeded.** Round 3 ended with `LAST*2 < PEAK`, the compaction signal, so `019fd631-83f4-70c2-b072-46840f1d4749` was retired and Round 4 ran in a **fresh session `019fd670-cadd-7112-aeb7-5e90e15cb2ce`**, re-seeded from `PLAN.md` plus the cumulative disposition ledger rather than resumed. Post-round telemetry: `EVENTS=30 PEAK=104469 PCT=40% NONRESUMABLE=no` — healthy, so Round 5 resumes this session.

Findings shifted from "is this correct?" to "is this **implementable**?", which is where a plan that has survived 39 fixes tends to break.

### Codex's critique

1. `[CRITICAL] Phase 0 step 2` — `scripts/build.js:59-66` swallows every webview build error and never cleans `dist/`, so stale bundles satisfy the existence-only gate and make both layers test old code. Fix: clean or atomically replace declared outputs, make configured build failures fatal, and verify the extension, rebase helper, seven JavaScript bundles, and generated CSS came from that invocation.
2. `[CRITICAL] Phase 2 steps 11–13 / Phase 6 step 37` — Record-twice equality proves determinism but never compares freshly recorded payloads with committed JSON, so changed emitters can leave stale type-valid fixtures and screenshots green. Fix: regenerate canonical payloads into a temporary directory in CI and byte-compare them with every committed fixture.
3. `[CRITICAL] Phase 0 steps 4–6 / Phase 6 step 39` — Host-fixture staleness checks only provenance, so incorrect CSS variables, classes, or datasets carrying valid metadata can generate self-consistent baselines and pass. Fix: recapture every pinned host fixture in the pinned container and compare its canonical content with the committed artifact.
4. `[CRITICAL] Phase 3 steps 15–16` — A table keyed by seven bundles cannot represent every production shell because `webview-mergeeditor.js` is hosted independently by `MergeEditorPanel` and `ShelfConflictEditorPanel`, allowing a host-specific shell regression to evade the drift guard. Fix: key shell configurations and drift checks by production host context, or assert shared-bundle contexts remain equivalent modulo explicitly ignored fields.
5. `[REQUIRED] Phase 1 steps 9–10 / Phase 4 step 24` — The plan requires exact assertions over Memento, SecretStorage, and per-webview state but defines no bridge through which the external Playwright process can seed or read those extension-host-only stores. Fix: add a development-only E2E control channel exposing allowlisted durable and webview state for seeding, snapshotting, reset, and negative-oracle tests.
6. `[REQUIRED] Phase 6 step 40` — An ellipsized element without `title` or `aria-label` still derives its full accessible name from DOM text and therefore correctly passes step 19, so the stated known-bad fixture cannot prove the oracle goes red. Fix: use a fixture whose computed accessible name is empty, truncated, or overridden with text differing from the canonical source.
7. `[REQUIRED] Phase 6 steps 36 and 40` — Including a deliberately type-invalid fixture in the mandatory `tsconfig.tests.json` project makes normal typechecking permanently fail, while excluding it proves nothing about that project's wiring. Fix: compile the negative fixture through a separate expected-failure project or subprocess extending the production test compiler options.
8. `[REQUIRED] Phase 1 step 8` — A module-scoped promise initializes once per Playwright worker rather than once per suite, and workers may run concurrently or restart after failures, invalidating the stated single-template and single-`fsck` contract. Fix: seed through global setup or a setup-project dependency with shared teardown, or explicitly constrain the E2E project to one worker.
9. `[REQUIRED] Goal / Risk R7` — "Restored byte-for-byte" and "byte-exact" contradict step 8's mandatory on-disk absolute-path rewrites and its normalized-equivalence contract. Fix: replace both remaining claims with "contract-checked recursive copy modulo declared live rewrites."
10. `[MINOR] Phase 0 step 4 / src/webviews/react/shared/theme.ts:10` — The citation says `theme.ts` reads body classes, but that line explicitly says it measures the resolved background instead. Fix: remove that citation and retain `shikiHighlighter.ts:68` as the verified body-class consumer.

### Claude's response

Three claims were verified against the repository before triage. All three held, and one of them turned out to be a bug in shipping code rather than a defect in the plan.

| Claim | Verified |
|---|---|
| #1 build gate defeated | **Confirmed, and it is a real product bug.** `scripts/build.js` wraps each webview build in `try { … } catch { console.log("Skipped (not found)") }` — a genuine esbuild failure is indistinguishable from a missing entry file, and nothing cleans `dist/`. A webview that fails to compile leaves the previous bundle in place and the build reports success. |
| #4 bundle→shell is not 1:1 | **Confirmed.** `webview-mergeeditor.js` is hosted by both `src/views/MergeEditorPanel.ts:343` and `src/views/ShelfConflictEditorPanel.ts:141`. There are 7 `buildWebviewShellHtml` call sites and 7 bundles, but they do not correspond. |
| #10 my citation was wrong | **Confirmed — my error.** `src/webviews/react/shared/theme.ts:9` says lane colours are chosen "by measuring the resolved editor background **rather than** by reading the `vscode-dark` / `vscode-light` body class", explicitly because custom themes carry a class that disagrees with what they paint. I misread a grep fragment during Round 2. `shikiHighlighter.ts:68` remains a verified body-class consumer, so the conclusion (capture the class list) survives; the supporting citation did not. |

Disposition — **10 FIXED**. No rejections this round. (Standing rejections remain in force: R1 #20's speculative canvas oracle, R2 #3's per-test `git fsck` scope limit.)

- **#1 FIXED**, and scope widened beyond what Codex asked for. Fixing only the test gate would leave the underlying bug shipping, so step 2 now also requires `scripts/build.js` to distinguish "entry absent" (skip) from "esbuild threw" (**fatal**) and to clean or atomically replace declared outputs. The gate then asserts **provenance by content hash**, not existence — the extension bundle, the rebase helper, all 7 webview bundles, and the generated CSS must be outputs of *that* invocation.
- **#2 FIXED** — record-twice proves the recorder is deterministic, never that the committed fixture matches what the extension now emits. CI regenerates every canonical payload into a temp directory and byte-compares against the committed JSON; updating a fixture becomes an explicit reviewable commit, like a baseline PNG.
- **#3 FIXED** — provenance certifies the label, not the artifact. Step 39 now **recaptures all four host fixtures in the pinned container** and byte-compares canonicalized content; provenance mismatch and content mismatch are both failures. Step 6 amended so the gate no longer advertises the weaker check.
- **#4 FIXED** — the shell table is re-keyed by **production host context (one row per `buildWebviewShellHtml` call site)**, not by bundle, with an equivalence assertion for rows sharing a bundle so intentional divergence must be declared. Step 16 gains a completeness assertion: row count must equal call-site count, so a new webview host cannot land unguarded.
- **#5 FIXED** — the sharpest finding of the round: the plan demanded exact assertions over stores no external process can read. Memento is internal VS Code storage and SecretStorage is the OS keyring, so this was unimplementable as written, and stubbing it would have produced exactly the silent false-green the plan exists to prevent. Added a **development-only E2E control channel**, deliberately narrowed beyond Codex's proposal: registered only when `INTELLIGIT_E2E=1` **and** `ExtensionMode.Development` (with a unit test asserting absence under `Production`), allowlisted keys only, and **secrets reported as presence + digest, never values** — a test assertion is not a reason to build a credential-exfiltration surface.
- **#6 FIXED** — my known-bad fixture was a leftover from the attribute-presence oracle that R3 #8 replaced, and it is not a failing case: an ellipsized element with no `title` still derives its full name from DOM text, so the oracle correctly passes. Replaced with fixtures whose *computed name* diverges from the source: an overriding `aria-label`, an empty/hidden name, and DOM-level truncation.
- **#7 FIXED** — both obvious placements are broken (include it and typecheck fails forever; exclude it and nothing is proven). The negative fixture compiles through `tsconfig.tests-negative.json`, which **extends** `tsconfig.tests.json` so it cannot drift into laxness, run as a subprocess asserted to exit non-zero with the expected diagnostic.
- **#8 FIXED** — module scope is **per worker process**, not per suite, and Playwright runs workers concurrently and restarts them after crashes, so "built once" and "one `fsck`" were both false under the real execution model. Replaced with a Playwright **setup project** declared as a `dependencies` entry, plus a teardown project.
- **#9 FIXED** — the two surviving "byte-for-byte"/"byte-exact" claims in the Goal and R7 contradicted step 8's own rehydration contract. Both replaced. (The remaining "byte-identical" in step 35 is correct: it describes workspace B being unchanged, which nothing rewrote.)
- **#10 FIXED** — false citation removed and the correction recorded inline in step 4 rather than silently deleted, so the reasoning is auditable.

Convergence: 20 → 8 → 11 → 10. Four **new** CRITICALs this round, which under the review schedule mandates the final round run at `ultra`.

---

## Round 5 (FINAL) — `gpt-5.6-sol` @ `ultra` — 8 findings (4 CRITICAL, 3 REQUIRED, 1 MINOR) — `VERDICT: REVISE`

Resumed session `019fd670-cadd-7112-aeb7-5e90e15cb2ce`. Post-round telemetry: `EVENTS=57 PEAK=181830 PCT=70%`, no compaction.

`ultra` was used here against the standing `codex-effort-ceiling-xhigh` preference. That preference is scoped to **build and fix** rounds, where the extra budget gets spent inventing scope inside a diff; this round was read-only, so that failure mode had nowhere to land, and the preference's own escape clause — all constraints defined up front — was satisfied by the six-item precision gate in the prompt (exact target, explicit non-goals, settled ledger, output contract, no-redesign clause, 8-finding cap).

### Codex's critique

1. `[CRITICAL] Phase 3 steps 15–16` — `CommitGraphViewProvider.getHtml` is one syntactic call site but resolves both full and compact graph bundles, so seven call-site rows can omit one runtime host context while the row-count check passes. Fix: key and compare the eight current resolved host invocations and assert exact context-ID set equality, not call-site count.
2. `[CRITICAL] Phase 1 step 10 / Phase 6 step 40` — The negative matrix tests only constant snapshots and `Production + INTELLIGIT_E2E=1`, so development-only gating, no-op seed/reset, unknown-key passthrough, or secret-field leakage can remain green. Fix: test the complete mode×environment truth table and table-driven seed→snapshot→reset, allowlist rejection, and exact redacted-secret contracts.
3. `[CRITICAL] Phase 6 step 40` — The new Step 2 provenance and Step 13 committed-payload comparators have no known-bad fixtures, while Step 39 tests mismatched provenance instead of corrupted content with valid provenance, permitting all three gates to regress to their previous false-green behavior. Fix: register stale-build, deterministic committed-payload mismatch, and same-provenance host-content mismatch fixtures.
4. `[CRITICAL] Phase 6 steps 36 and 40` — The negative TypeScript project can fail correctly even if the production `typecheck` script never invokes `tsconfig.tests.json`, preserving the original untyped-fixture blind spot. Fix: assert and execute the positive tests project through the real `typecheck` command before running the expected-failure project.
5. `[REQUIRED] Phase 1 step 10 / Phase 4 step 24` — An extension-host command cannot directly read or reset renderer-owned `acquireVsCodeApi().getState()/setState()`, so the webview-state oracle is unimplementable without acknowledged host↔webview messaging. Fix: specify correlated E2E-only RPC that fails on missing or unacknowledged views and updates both persisted and mounted state, or reloads and verifies rehydration.
6. `[REQUIRED] Phase 1 step 8` — A Playwright setup project runs in its own worker process, so setting its environment cannot publish the newly created template path to dependent-project workers. Fix: publish an atomic per-run manifest at a runner-known path, or produce the environment value from `globalSetup`.
7. `[REQUIRED] Phase 1 step 10` — Dynamic command registration alone is not Command-Palette-visible, while a static contribution ships in the extension manifest and palette invocation supplies neither structured arguments nor a machine-readable result. Fix: define a gated palette contribution plus nonce-bound fixture-owned request/result transport, and assert the packaged production manifest excludes the control command.
8. `[MINOR] Phase 3 step 18 / undocked-section-widths.test.ts` — The cited test exercises only a 1200px layout and does not demonstrate the claimed narrow-versus-wide branch. Fix: cite `sectionWidths.ts:88-104` or add a narrow-width assertion to the cited test.

### Claude's response

Four claims verified against the repository. All four held.

| Claim | Verified |
|---|---|
| #1 call-site keying still collides | **Confirmed.** `CommitGraphViewProvider` is constructed twice — `src/activation/repositoryMode.ts:283` (default `webview-commitgraph.js`) and `:289` with `scriptFile: "webview-compactcommitgraph.js"`. One call site, two runtime hosts: **7 bundles, 7 call sites, 8 contexts.** |
| #5 host cannot read webview state | **Confirmed.** `getState`/`setState` are the renderer-side API (`src/webviews/react/shared/vscodeApi.ts:9-10`); no extension-host API reads them. |
| #7 palette transport unworkable | **Confirmed.** `package.json` statically contributes 115 commands — palette visibility *requires* `contributes.commands`, so a gated command ships in the marketplace manifest, and palette invocation carries no arguments and returns no value. |
| #8 citation overclaims | **Confirmed — my error.** `tests/webview/unit/undocked-section-widths.test.ts:11` only exercises 1200px and shows no narrow/wide branch. |

Disposition — **8 FIXED, 0 rejected.**

The distribution is the finding that matters: **all 8 trace to material changed in Round 4. None touches anything that survived rounds 1–3.** Three (#5, #6, #7) attack the E2E control channel and the setup-project template — both *added* in Round 4 and reviewed exactly once. Three (#1, #3, #4) are Round-4 fixes that relocated a defect instead of removing it. #1 is the cleanest example: I replaced bundle-keying with call-site-keying and reintroduced the identical 1:1 assumption one level up. #3 is the most self-inconsistent: I added three new gates and registered zero known-bad fixtures for them, breaking the plan's own governing principle in the same edit that strengthened it.

- **#1 FIXED** — keyed by **resolved host context** with all 8 enumerated in a table, and the completeness check changed from a count to **exact set equality over context IDs**. A count passes while one context is missing and another duplicated — the exact shape of the bug.
- **#2 FIXED** — the two sampled negatives replaced by the full matrix: all four mode×env cells, table-driven seed→snapshot→reset per allowlisted key, allowlist rejection, secret-redaction contract, unmounted-view failure, and a packaging assertion.
- **#3 FIXED** — fixtures registered for build provenance (stale bundle by hash; esbuild throw must fail the build) and committed-payload freshness (single-byte drift). Step 39 gains the fixture that actually matters: **valid provenance, corrupted content**.
- **#4 FIXED** — the negative project proves nothing if `typecheck` never references the positive one. The check now runs the **real `typecheck` command** first and asserts its project graph covers the fixture files, verified by a temporarily type-invalid file turning that command red.
- **#5 FIXED** — the webview leg cannot be a host read. Specified as correlated host↔webview RPC handled in the single `vscodeApi` acquisition wrapper, runtime-gated on a shell-injected flag (**not** a build-time `define`, which would produce a different bundle for tests than production and destroy Layer 1's premise), with unmounted/unacknowledged views failing hard and seeding forcing a remount plus post-reload rehydration.
- **#6 FIXED** — env publication swapped for an **atomic per-run manifest at a runner-known path**. A setup project runs in its own worker, so the env mechanism would have silently produced per-worker template rebuilds — the very thing the Round-4 fix was for.
- **#7 FIXED**, diverging from the proposed fix. Codex suggested a *gated palette contribution plus* a transport; the palette half is unnecessary and is the part that leaks into the marketplace manifest, so it was dropped entirely. Transport is a **nonce-bound file exchange in the fixture-owned root** (temp-write + rename), nothing contributed to `package.json`, three independent activation gates, and a packaging test asserting the `.vsix` manifest carries no control command.
- **#8 FIXED** — false citation withdrawn inline and replaced with `src/webviews/react/undocked/sectionWidths.ts`.

### Resolution — arbitrated close at MAX_ROUNDS

Round 5 was `MAX_ROUNDS`, and it returned `REVISE`, so the loop reached its bound without a clean `APPROVED`. Presented to the owner as a deadlock with three options (scoped confirmation round / arbitrated close / stop) plus a separate design question on whether to defer the control channel to Phase 5.

**Owner decision: apply all 8 fixes and close to build. Control channel stays in Phase 1.**

Recorded risk, raised before the decision and reaffirmed after: the E2E control channel is the one component that has never passed a review round — it was introduced in Round 4 to resolve R4 #5, and both times it has been examined it returned CRITICALs. It is also the most security-adjacent piece of the harness (dev-only activation, secret handling). It is specified in full above rather than sketched, precisely because it will not get another adversarial pass before implementation.

**Final tally: 5 rounds, 57 findings, 56 fixed, 1 partial reject, 1 scope limit.** Trajectory 20 → 8 → 11 → 10 → 8.

---

## Act 3 — Build

Builder is **Sonnet 5** (subagents at high/xhigh effort) and the session root, not
Codex — owner override at handoff: *"this time dont use codex for implementation
use sonnet for the implementaton and rest of the workflow remains the same."*
Everything else in the `claudex-build` contract stands unchanged: Claude reviews
the diff, runs the deterministic gates, commits each accepted phase, and never
lets a builder's self-report count as proof.

### Resolved tunables

| Var | Value |
|-----|-------|
| `SPEC_FILE` | `PLAN.md` |
| `LOG_FILE` | `PLAN-REVIEW-LOG.md` (this file) |
| `BUILD_MODEL` / `BUILD_EFFORT` | `sonnet` (Agent tool) / high–xhigh — owner override, see above |
| `SANDBOX` | n/a (Agent-tool subagents, not `codex exec`) |
| `MAX_FIX_ROUNDS` | 2, then root takeover |
| `GATES_FILE` | `.claudex-gates.json` — 6 gates: lint, typecheck, format, knip, architecture, suite |
| `PROOF_CMD` | `npm run -s test` (the `suite` accept-stage gate) |
| `SEAL_MODE` | `shadow` |
| `BASE_HEAD` (Phase 0) | `bc9a502c9ea3a7ec4d4df531076fac547fbd5962` |

### Protocol deviation, recorded

Phase 0 was built and verified **before** this log section existed. The owner
caught it: *"make sure to commit the changes after every phase … why arent you
followinf claudex build skill."* Both halves of that are correct — Phase 0 sat
verified-but-uncommitted, and the round evidence was living in the session
transcript instead of here. This section is the correction; from Phase 1 onward
the entries are written as each round closes, and every phase commits at
acceptance.

---

### Phase 0 — Feasibility spike + host-fixture capture (PLAN.md steps 1–6)

**Deliverables**

| # | Deliverable | State | Evidence |
|---|---|---|---|
| 1 | Playwright + `@vscode/test-electron` chosen over Cypress, pinned | DONE | `playwright.e2e.config.ts`; Playwright 1.62.1 driving Electron 42.7.1 / VS Code 1.132.0 (`df53daabb18cd157bdb08c7f01c34df936cf12f4`) |
| 2 | Real VS Code launches under Playwright with the extension loaded | DONE | `tests/e2e/spike/launch.spec.ts` green, 3.0s |
| 3 | Host theme fixtures captured from the real product, not hand-written | DONE | `tests/e2e/hostFixtures/*` + `scripts/capture-host-fixtures.ts`; 11.8s for four themes |
| 4 | Four *distinct* fixtures (dark/light/hc-black/hc-light) | DONE | `tests/visual/fixtures/host/*.json` — 4 of 4 distinct, each ~890 `--vscode-` custom properties |
| 5 | Capture is byte-reproducible | DONE | two independent runs diffed byte-for-byte, `ALL_IDENTICAL=1` |
| 6 | Build provenance manifest so Layer 1 can never diff a stale bundle | DONE | `scripts/buildManifest.js`, `scripts/verifyBuildProvenance.js`, `scripts/build.js` rewrite |
| 7 | Pinned Linux container for reproducible baseline generation | PARTIAL | `tests/e2e/docker/{Dockerfile,run.sh,base-image.txt}` authored, digest pinned to the linux/amd64 manifest, arch assertion in `run.sh`; **container never executed** — see the open gate below |

**The load-bearing defect this phase actually found.** Launching VS Code with
the sanitized scratch `HOME` from `createSanitizedGitEnv` hung every Playwright
channel for the full timeout with the app still rendering perfectly on screen.
Root cause: the scratch `HOME` makes VS Code's SecretStorage reach for the macOS
keychain, raising a **modal native prompt owned by the Electron main process**.
Playwright drives Electron *through* the main process, so `page.evaluate`,
`page.screenshot` and `electronApp.evaluate` all die at once — and
`page.evaluate` has no timeout in Playwright (it is not an "action", so
`actionTimeout` does not bound it), which is why it presented as a silent
10-minute hang rather than a failure.

Fix: `--use-inmemory-secretstorage` in `buildElectronLaunchArgs`
(`tests/e2e/hostFixtures/electronLaunchHelpers.ts`) and in the spike. This is
**not** redundant with the `--password-store=basic` that was already there —
that flag governs only Chromium's own password store; VS Code's SecretStorage
is a separate path. Isolated by ablation against this exact build: bare env
renders; `GIT_CONFIG_GLOBAL` alone renders; scratch `HOME` alone **hangs**;
scratch `HOME` + the flag renders. Keeping it is also the right security
posture independent of the hang — a disposable test profile must never reach
the developer's real secret store.

Two wrong diagnoses preceded it and are recorded because both are cheap to
repeat: (a) `ps pcpu` is a **lifetime average**, not instantaneous CPU — reading
47% as a live spin loop produced a false "standalone VS Code also hangs";
(b) renderer logs stopping at 1.2s reads as a freeze but is exactly what an
*idle* standalone instance does too. The decisive evidence was that a
main-process `electronApp.evaluate` died simultaneously with the page channel,
which proves transport death rather than a renderer stall.

A second, unrelated latent trap was fixed in the same phase: Playwright's
default `actionTimeout` is `0` — wait forever. `playwright.e2e.config.ts` now
pins `actionTimeout: 20_000`. This did **not** fix the hang (evaluate is not an
action) and is not claimed to have.

**Proof.** Accept-stage gates via `python3 ~/.claude/skills/claudex-build/verify.py gates --base bc9a502c --stage accept` — lint, typecheck, format, knip, architecture, and the broad suite `npm run -s test`. Result recorded in the verdict entry below.

**Open gate — stated plainly, not waved off.** PLAN.md step 6 gates Phase 0 on
steps 3–5 working *on macOS local **and** in the pinned Linux container*. The
macOS half is verified. **The container half has not been executed.** The
pin itself is now resolved — `base-image.txt` carries a real digest instead of
its `__PENDING_DIGEST__` placeholder — so `run.sh` will build; it simply has not
been run yet. Phase 0 is therefore committed as **macOS-verified, Linux gate
open**, not as fully gated. That run is the next task; if it fails, step 6's own
instruction applies — stop and re-plan — and that re-plan lands before any
Layer 1 baseline is committed.

Two corrections were made to the pin while resolving it, both about the same
failure mode:

1. `docker inspect --format '{{index .RepoDigests 0}}'` — what the file's own
   instructions said to use — returns the **image index** digest, which carries
   amd64 *and* arm64 (verified: `docker manifest inspect` lists both). Pinning
   it leaves the architecture decided by whether `--platform` was passed, and on
   an Apple Silicon machine a direct `docker build` silently yields arm64. Since
   font rasterization differs by architecture, that produces baselines nobody
   else can reproduce, showing up as antialiasing noise with nothing in the diff
   naming the cause. The pin is now the **linux/amd64 manifest digest**
   (`sha256:c091b21d…`, not the index's `sha256:dcc5531e…`), so architecture is
   part of the pin rather than part of the command line, and the re-resolve
   recipe in the file was rewritten to match.
2. A pin that cannot be checked is not an oracle. `run.sh` now asserts the built
   image reports `amd64` and fails loudly otherwise — the pin's own claim, made
   falsifiable.

**Round 1 — accept-stage gates**
`python3 ~/.claude/skills/claudex-build/verify.py gates --base bc9a502c --stage accept`

```
gate lint:         OK    12.6s
gate typecheck:    OK     4.5s
gate format:       OK     2.8s
gate knip:         FAIL   1.4s
gate architecture: OK     1.2s
gate suite:        OK    84.0s
GATES: RED warn=0
```

`knip` RED with 11 findings. Named before any rerun, per the no-unnamed-flake
rule — and none of them was a flake:

| Finding | Disposition |
|---|---|
| `tests/e2e/globalSetup.ts` reported as an unused **file** | **Real, fixed in `knip.json`.** Not dead code — knip's project graph could not reach it. `playwright.e2e.config.ts` is deliberately not named `playwright.config.ts` (the repo's default runner is Vitest, and the default name gets claimed by tooling that assumes otherwise), so knip's Playwright plugin no longer auto-detects it and never resolves `testDir` or `globalSetup`. Declared the path under a `playwright` plugin block. Deleting the file — the reading the raw report invites — would have removed the pre-test VS Code download and reintroduced the cold-cache timeout it exists to prevent. |
| `hostFixtureFileName`, `vscodeCachePath`, `assertExecutableIsOutsideRepo` unused **exports** | **Real, fixed.** All three are used only inside their own module; the `export` keyword was unjustified. Dropped. Worth stating because the first read was wrong: `assertExecutableIsOutsideRepo` looked like a dead in-repo-cache guard, and it is not — it is called at `resolveVSCodeExecutable.ts:113`. The guard is wired; only its visibility was excessive. |
| `HostFixtureProvenance`, `HostFixtureElementSnapshot`, `HostFixtureDocumentElementSnapshot`, `RawElementSnapshot` unused **types** | **Real, fixed.** Internal composition types for the two exported top-level shapes. Un-exported. Consumers reading `.provenance` are unaffected — TypeScript is structural. |
| `createSanitizedGitEnv`, `SanitizedGitEnv`, `FixtureCommits` in `tests/fixtures/repo/seed.ts` | **Not Phase 0.** Phase 1 step 7 output, untracked and excluded from this commit. Genuinely unreferenced today because `harness.ts` (step 8) does not exist yet; they resolve at Phase 1 acceptance. |

`knip.json` also gained `scripts/**/*.ts` to `project` (it previously covered
only `scripts/**/*.js`, so `scripts/capture-host-fixtures.ts` sat outside the
graph entirely).

**Gate-teeth check.** A gate that reports nothing is indistinguishable from a
gate that cannot see anything, so the fixed configuration was proved able to
fail before it was trusted:

- dead file dropped in `scripts/` → **flagged** (`Unused files (1) scripts/__canaryA.ts`);
- dead file dropped in `tests/` → **flagged**;
- dead export appended to a non-entry e2e module → **flagged**
  (`canaryC  function  tests/e2e/hostFixtures/canonicalizeHostFixture.ts:67:17`).

All three canaries removed; `git status --porcelain` confirmed clean afterwards.
One follow-up from the same probe: `scripts/capture-host-fixtures.ts` is *not*
export-checked, and that is correct rather than a hole — `package.json` declares
`"capture:host-fixtures": "… bun scripts/capture-host-fixtures.ts"`, which makes
it an entry file, and knip intentionally does not report unused exports in entry
files without `--include-entry-exports`.

### Claude's verdict — Phase 0

- **HEAD gate, restated by root:** `BASE_HEAD bc9a502c9ea3a7ec4d4df531076fac547fbd5962 == HEAD bc9a502c9ea3a7ec4d4df531076fac547fbd5962`. No builder moved a ref.
- **Findings:** 8 Phase 0 defects, all confirmed by root against the files (not accepted on report), all fixed. 3 deferred to Phase 1 with reasons above. 0 rejected.
- **Proof:** `npm run -s test` green at 84.0s as the `suite` accept gate; `lint`, `typecheck`, `format`, `architecture` green; `knip` green on every Phase 0 path after the fixes, with the three `seed.ts` findings isolated to untracked Phase 1 work.
- **Verdict: ACCEPT — macOS-verified, Linux container gate open.** Committed on that basis, with the open gate named in the commit message rather than left for a reader to discover.

### Phase 0 — closing step 6's Linux container gate

Run against a clean clone of `df3370fd`, so the two Phase 1 lanes' in-flight
work could not contaminate it. **`gate_rc=0`**: spike passed (`1 passed`, the
test itself 37.0s; 20.9m wall under amd64 emulation), capture passed
(`1 passed (1.0m)`), four fixtures written with correct and distinct theme
kinds — `vscode-dark`, `vscode-light`, `vscode-high-contrast`,
`vscode-high-contrast-light` — under `platform: "linux-x64"`.

**PLAN.md step 6 is now satisfied on both halves.** Phase 0 is fully gated.

It took three attempts, and the two failures are the entire justification for
the plan requiring a container run rather than trusting a developer laptop:
neither reproduces on macOS, and both would first have surfaced in CI.

| # | Failure | Cause | Fix |
|---|---|---|---|
| 1 | `run.sh: line 73: TTY_FLAGS[@]: unbound variable` | `set -u` + an **empty** array expansion. bash before 4.4 treats an empty array's `[@]` as unset and aborts — and the array is empty exactly when there is no TTY, i.e. only in CI. An interactive run passes. macOS still ships bash 3.2 as `/bin/bash`. | `${TTY_FLAGS[@]+"${TTY_FLAGS[@]}"}`. Ablated on bash 3.2.57: old form aborts, new form runs, and a non-empty array still forwards `-i -t`. |
| 2 | `error: bun is unable to write files: AccessDenied` | Docker creates a named volume owned by `root:root`, but the container deliberately runs unprivileged (Electron will not start its sandbox as root). The bind-mounted checkout is owned by the host uid, which is not `pwuser`'s 1000. Nothing was writable, and the error names no path — it reads like a bun bug. | Both named volumes replaced with host-owned bind mounts under one cache root; container runs `--user $(id -u):$(id -g)`, still unprivileged, so the sandbox reasoning holds; `HOME` and `INTELLIGIT_VSCODE_CACHE` redirected, since that uid has no `/etc/passwd` entry and would otherwise land on `pwuser`'s unwritable home. Smoke-tested all four mounts before re-running. |

### Finding for Phase 3 (step 20) — host fixtures are *almost* platform-independent

The container's fixtures were diffed property-by-property against the committed
macOS ones (a line diff is useless here — `styleCssText` is a single ~890-entry
line). Result across all four themes:

| Fixture | props | only-darwin | only-linux | changed |
|---|---|---|---|---|
| dark-modern | 891 / 891 | 0 | 0 | 3 |
| light-modern | 893 / 893 | 0 | 0 | 3 |
| hc-black | 760 / 760 | 0 | 0 | 3 |
| hc-light | 789 / 789 | 0 | 0 | 3 |

**Every colour token is identical on both platforms.** The only differences are
the same three font properties in every fixture, plus `provenance.platform`:

- `--vscode-editor-font-family`: `Menlo, Monaco, 'Courier New', monospace` → `'Droid Sans Mono', monospace`
- `--vscode-editor-font-size`: `12px` → `14px`
- `--vscode-font-family`: `-apple-system, BlinkMacSystemFont, sans-serif` → `system-ui, "Ubuntu", "Droid Sans", sans-serif`

This is stronger evidence for step 20's container-only baseline rule than the
plan had. It is not merely that glyph rasterization differs between
architectures — **the font size itself differs, 12px vs 14px**, which changes
text metrics and therefore layout, not just antialiasing. A baseline generated
against a macOS host fixture cannot be reproduced anywhere else, and the diff
would show wholesale layout shift with no obvious cause.

**Two consequences the plan does not yet address. Owner decision needed at
Phase 3, deliberately not taken here:**

1. **Which fixtures get committed.** Layer 1 renders bundles against a host
   fixture inside the baseline container. If the committed fixture names `Menlo`,
   a font absent from the container, rendering silently falls back and the
   baseline encodes the fallback. That argues the committed fixtures should be
   the **container-generated** (`linux-x64`) ones, not the macOS ones currently
   in the tree.
2. **Step 39's recapture-and-compare freshness check then cannot run on macOS.**
   Recapturing on a developer laptop would produce `darwin-arm64` fixtures that
   differ from the committed `linux-x64` ones in exactly these four fields, and
   the check would go red for a reason that is not staleness. It needs to either
   run only in the container, or compare modulo a named, explicit set of
   platform-varying fields — and if the latter, that exclusion list is itself a
   place false-greens can hide, so it must be registered with a known-bad fixture
   like every other oracle in this plan.

Phase 0 committed the macOS fixtures because that is what it captured and
proved reproducible; swapping them is a Phase 3 decision with a real tradeoff,
so it is raised here rather than made silently.

---

## Phase 1 — fixture repository + E2E control channel — ACCEPTED `2ada2bad`

Builder: **Sonnet 5** subagent lanes at high effort (standing user override: Codex
is not the builder for this build; it remains the read-only reviewer). Root
(Opus 5) owned the spec, the review of every returned diff, and all acceptance.
Rounds: build + 2 fix lanes + root-owned integration edits. No Codex round.

**Scope delivered**

- `tests/fixtures/repo/` — deterministic seed (fixed identities, incrementing
  deterministic clock, merge/conflict/ahead-behind branches over a shared
  multi-lane merge base, tags, pre-seeded dirty layer), per-test copy with
  inode + symlink independence proof, on-disk origin-URL rehydration with a
  normalized-diff assertion, manifest publish/claim, workspace snapshot +
  normalize.
- `src/e2e/` — development-only control channel: allowlisted keys, secrets as
  presence + digest only, three independent gates.
- Playwright setup/teardown projects wired in `playwright.e2e.config.ts`;
  `tests/e2e/fixtureTemplate.setup.ts` / `.teardown.ts` are thin wrappers.

**Proof (all re-run by root, not taken from the builder)**

| Gate | Result |
|---|---|
| `bun run test` | 197 files / 3003 tests, rc=0 |
| pre-commit hook (all nine checks) | `PRECOMMIT_RC=0` |
| `git commit --amend` re-running the hook | `AMEND_RC=0` |
| knip (`deps:check:strict`) | 0 findings, **0 ignores added** |
| `architecture:check` (dependency-cruiser) | 291 modules, 0 violations |
| tests-tree typecheck (`tests/fixtures`, `tests/unit`, `tests/e2e`) | rc=0 |
| `vsce ls --tree` | no Playwright config / `test-results/` in the package |
| `detect_changes` (codebase-memory) | exactly the 7 expected changed files |

**Oracles proven able to fail (the governing principle of this plan)**

- Webview id-collision oracle: reverting the `e2eViewId` plumbing drives it RED,
  three instances collapsing onto one registry key.
- `claimFixtureManifest`: 10 concurrent claimants leave exactly 1 winner;
  substituting `existsSync` + `rename` lets 8 of 10 win. The `link(2)` version is
  race-free by construction — the existence check and the publish are one syscall.
- `runFixtureSetup` ordering (seed → `git fsck` workspace AND bare origin →
  publish) means a corrupt template is never reachable through the manifest. The
  signal is the exit code alone: plain `git fsck` on a healthy seeded template
  exits 0 with empty output, because default fsck treats every ref's reflog as a
  reachability root.

**Four defects found during acceptance that every obvious gate missed**

1. **Raw NUL bytes in three files** (`MergeEditorPanel.ts`,
   `ShelfConflictEditorPanel.ts`, `webviewHtmlBootstrap.test.ts`) — from this
   branch's own `e2eViewId` work. NUL-joining composite keys IS this codebase's
   idiom, so the design was right and only the encoding was wrong: the existing
   code writes the escape sequence, these wrote a raw `0x00`. Identical runtime
   value, so `tsc`, eslint and all 3003 tests stayed green — the only symptom was
   git reclassifying the files as binary and refusing a reviewable diff.
2. **A real `TS2322` in Phase 0's `launch.spec.ts`** — `NodeJS.ProcessEnv`
   (`string | undefined`) passed to `_electron.launch`, which requires all-string
   values. Visible only after widening a typecheck over `tests/e2e/**`:
   `tsconfig.json` excludes `tests/` and vitest transpiles without typechecking,
   so type errors under `tests/` are invisible to BOTH repo gates (step 36).
   Fixed by dropping undefined-valued keys, not by casting.
3. **A circular dependency** `e2eStateBridge → vscodeApi → e2eStateBridge`. The
   repo sets `tsPreCompilationDeps: true`, so a **type-only** import edge still
   counts. Fixed structurally — `VsCodeApi` now lives in a leaf module
   `vscodeApiTypes.ts` and is re-exported, so every import site is unchanged. No
   config exemption.
4. **A packaging leak** — `.vscodeignore` was shipping `playwright.e2e.config.ts`
   and `test-results/` into the published `.vsix`; `tests/**` covers neither a
   root-level config nor Playwright's output directory.

Defects 3 and 4 were caught only because the reflexive `--no-verify` on the first
commit was reverted and the hook was allowed to run. Under `set -e` each failure
hid the ones behind it, so they came out one per chain run, across three runs.

**Deliberate call:** knip was taken 21 → 0 findings with **zero** entries added to
an ignore list — barrel re-exports no consumer routed through were deleted, and
in-module-only exports were un-exported. Green-with-no-ignores is what makes the
next dead export get caught.

**Still owed before any push:** `security-reviewer` on the new `src/e2e/` secrets
surface (Tier 1 project rule). Nothing has been pushed; `main` is 3 commits ahead
of the remote and the tree is clean.

---

## Handoff — resume at Phase 2

- `BASE_HEAD` = `2ada2bad` (tree clean, unpushed, `main`)
- `SPEC_FILE` = `PLAN.md`, `LOG_FILE` = `PLAN-REVIEW-LOG.md`
- Builder override in force: **Sonnet 5 at high/xhigh effort**, not Codex. Root
  (Opus 5) keeps review, integration, verification, and the commit. Commit after
  every phase. Codex stays read-only if used for review at all.
- Phases committed so far: Phase 0 → `df3370fd` + `24a0f775`; Phase 1 → `2ada2bad`.
- Phases remaining: 2 (recorder), 3 (visual harness), 4 (~10 E2E flows),
  5 (nightly sweep), 6 (infra unit tests).
- **Open owner decision, carried from Phase 0, due at Phase 3:** whether the
  committed host fixtures become the container-generated `linux-x64` ones, and how
  step 39's recapture-and-compare survives on macOS. See the Phase 0 section above.
- Recurring traps for the next session: the tests-tree typecheck hole (step 36),
  `tsPreCompilationDeps` making type-only imports real edges, and never passing
  `--no-verify` in this repo.

Stopping here is the `claudex-build` checkpoint rule, not a scope cut: this
orchestrator session has already auto-compacted, so Phase 2 is not launched from
it. Relaunch `/claudex-build PLAN.md` in a fresh session — the spec, this log, and
the committed tree are the entire state.

---

## Phases 2–3 — backfilled from the commit log

The sessions that built Phases 2 and 3 kept their state in the project memory
files rather than here, so this section is a **reconstruction from `git log`**,
not a contemporaneous record. Per-round verifier reports for these commits do
not exist; the commits and their subjects are the evidence. `2ada2bad..8005a945`,
oldest first:

| Commit | Slice |
|---|---|
| `fed8ee25` | docs — Phase 1 acceptance + Phase 2 handoff |
| `572b9130` | docs — security review deferred to a final Phase 7 gate |
| `95bca586` | 2a — capture extension→webview messages at the boundary |
| `746c8814` | 2b — deterministic canonicalization of recorded payloads |
| `8acc8c07` | 2c-i — record a real webview payload end to end |
| `91008597` | 2c-ii — repo-wide regenerate-and-compare gate for fixtures |
| `28c2188f` | 2c-iii — the eight-state repository scenario layer |
| `3d3702a3` | 2c-iv-a — scenario-aware fixture registry and gate |
| `24b7e248` | 2c-iv-b — commit-graph card + compact recorders |
| `85f67a1e` | 2c-iv-c — commit-panel recorder |
| `090ce653` | fix — pin recordings to the scenario's sanitized git environment |
| `a968d851` | 2c-v-a — WebviewPanel double + merge-conflict-session recorder |
| `167f16e7` | 2c-v-b — merge-editor recorder |
| `16255d30` | 2c-v-c — undocked recorder |
| `5cfe9922` | 2c-v-d — shelf-conflict-editor recorder |
| `f3e3e58b` | fix — localize ShelfConflictEditorPanel's user-facing strings |
| `dd36444f` | 3-i — resolved host-context shell table + production oracle |
| `a2161ec2` | 3-ii — harness document renderer + acquireVsCodeApi stub |
| `c0c026c8` | 3-iii — Playwright visual config + in-process harness page |
| `f349648f` | ci — visual suite in the pinned container, gating `release` |
| `5c72cdb3` | 19-a — pure clipping, contrast, accessible-name oracles |
| `8005a945` | 19-b — hc projects + live-page collectors + ratchet baseline |

Standing findings carried forward: the volatile-field mechanism is still
exercised only with `[]` across all eight recorders; and the tests-tree
typecheck hole (step 36) still applies — `tsconfig.json` excludes `tests/`,
`lint:strict` is `eslint src scripts`, and `format:check` covers only `src/**`
and `scripts/**`, so nothing under `tests/` is statically gated. Test-tree
changes are proved by running them, not by the gates.

---

## Phase 3 — closing the container gate — the CI `visual` job was red

`BASE_HEAD` = `8005a945`. Docker was unavailable when `f349648f` wired the
`visual` job into `publish.yml`, so `tests/e2e/docker/run.sh` had **never been
executed** and a job that gates `release` was unproven. Running it is the first
thing this session did.

### Round 1 — the container run itself (root-direct, no Codex round)

`./tests/e2e/docker/run.sh 'bun install --frozen-lockfile && bun run build && bun run test:visual'`

The container path is sound end to end — amd64 image built under emulation on an
arm64 host, `bun install --frozen-lockfile` clean, all seven webview bundles
built, Playwright 1.62.1 resolving the base image's own browsers (the lockfile
pins 1.62.1 exactly, matching the digest in `base-image.txt`). Result:
**4 failed, 92 passed (4.3m)**, every failure the same shape:

```
[<theme>-narrow] undocked clipping: 1 baselined finding(s) no longer occur
  - span.css-ej7pzn (… > label:nth-of-type(1) > span:nth-of-type(2))
```

The `✘` markers on `harnessSmoke.spec.ts:62` are `test.fail()` expected-fail
markers; they are inside the 92 passed, not failures.

This is the two-way ratchet's `resolved` direction firing exactly as designed in
`8005a945`: the baseline claims a clip that does not happen on `linux-x64`.
Regenerating inside the container and diffing gives the measurement:

```
tests/visual/fixtures/knownFindings.json | 12 ++++--------
```

**One finding, four narrow projects, nothing else changed.** 139 of ~140
findings are byte-identical across `darwin-arm64` and `linux-x64`. The oracles
are host-stable; this single element is not.

### Cause, and why the fix is a lock rather than a tolerance

Not glyph rasterization. The Phase 0 finding above already measured the real
cause: the committed host fixtures name `-apple-system, BlinkMacSystemFont` at
`12px`, the container's name `system-ui, "Ubuntu", "Droid Sans"` at `14px`. The
harness feeds a macOS host fixture into a Linux container, so that label resolves
to a different font and the span fits where it used to overflow. No font-family
string is platform-neutral, so this cannot be normalized away — one platform has
to own the file, and CI's is the one that gates releases.

Fix: `UPDATE_VISUAL_BASELINE=1` now refuses to write anywhere but `linux-x64`,
checked *before* the existing single-worker guard because it is the more
expensive mistake — a host-side regeneration completes, looks clean, and only
turns red later in CI.

### Evidence

Root's HEAD gate: `BASE_HEAD 8005a945 == HEAD 8005a945, checked by root`.

| Row | What | Expected | Result |
|---|---|---|---|
| M1 | `UPDATE_VISUAL_BASELINE=1` on `darwin-arm64` | RED, baseline untouched | RED, rc=1; message names `linux-x64` and the exact container command; baseline md5 unchanged at `90f71731…` |
| M2 | full suite in the container against the regenerated baseline | 96/96 | **96 passed (3.7m)**, zero failed — the four `undocked` narrow failures are gone and nothing else moved |

**Owner decision, now evidence-backed rather than open** (raised at Phase 0 and
deferred to Phase 3): the committed host fixtures should become the
container-generated `linux-x64` ones. Rendering a macOS fixture inside the Linux
container simulates no real user — a macOS user gets Menlo, a Linux user gets
Droid Sans, and the container gets "Menlo requested, Droid Sans delivered."
Proceeding on that default at step 20. It is flagged, not blocked; reversing it
costs one four-minute regeneration.

---

## Phase 19-c-i — an oracle that could not fail

`BASE_HEAD` = `112e8355`. Both rounds `gpt-5.6-luna` at `max`, each verified from
its own session rollout rather than from the launch command.

### Round 1 — build (SID `019fe800-3441-74e0-a122-a7308562f4d1`)

The accessible-name oracle was tautological: `collectOracleInputs.ts` built
`computedName` as `getAttribute("aria-label") ?? textContent` and `sourceText` as
`textContent`, so for every element without an aria-label it compared a value to
itself. All 64 `accessibleNames` arrays in the baseline were `[]` — not because
the product was clean, but because the comparison had no second opinion.

Replacement: a pure module `tests/visual/oracles/truncationSources.ts` whose
expected value comes from OUTSIDE the DOM (the recorded fixture payload) and
whose observed value is Playwright's own accessible-name computation. The old
`accessibleName.ts` and its unit test were deleted (212 lines).

Round 1 implemented the work order faithfully. **The work order was wrong twice,
and both defects were the reviewer's.**

### Defect 1 — the tautology became a vacuum (measured, not argued)

The work order said "keep the `style.textOverflow === "ellipsis"` split exactly as
it is", so `renderedTexts` was collected only for elements that CSS-ellipsize. But
`text-overflow: ellipsis` is a paint-time effect — it never modifies
`textContent`. Every string in that bucket is therefore the full untruncated text,
`matchTruncatedRendering` hits its equality guard, and the bucket can never
produce a finding.

Probe, mounting all eight contexts at `dark-modern-narrow` and counting elements
with direct text:

| context | `text-overflow: ellipsis` | of those, containing a literal ellipsis |
|---|---|---|
| commit-graph-card | 26 | 0 |
| commit-graph-compact | 13 | 0 |
| commit-panel | 11 | 0 |
| commit-info | 1 | 0 |
| undocked | 33 | 0 |
| merge-editor | 4 | 0 |
| shelf-conflict-editor | 4 | 0 |
| merge-conflict-session | 2 | 0 |

Zero in all eight. Meanwhile `merge-conflict-session` renders `"Merge..."` — a
real JS-truncated label — on an element WITHOUT `text-overflow: ellipsis`, so it
landed in the `clipping` bucket and the oracle never saw the one element it
existed to check. Fix: collect `renderedTexts` for every direct-text candidate;
the `textOverflow` test now governs the clipping bucket only.

### Defect 2 — `expect.soft` bypasses the ratchet

The work order told Round 1 to use `expect.soft` "so a failure becomes a baseline
finding key rather than an immediate throw". That is not what soft does: a soft
failure is recorded and Playwright fails the test at teardown, so any finding
turns the suite red regardless of the baseline — and on an ambiguous match the
loop ran one assertion per candidate source, of which at most one can pass,
guaranteeing recorded errors. Fix: a catchable assertion with a 250 ms timeout
(the page is static after mount), failure turned into a finding key, the ratchet
left as the only thing deciding red vs green.

### Evidence

Round 1's RED was "the module did not exist yet" — a compile error, not behavior.
The gate for this phase is a PRODUCTION mutation.

| Row | What | Expected | Result |
|---|---|---|---|
| M3 | host, `merge-conflict-session`, unmutated | green | 1 passed (835 ms) |
| M4 | `MergeConflictSessionApp.tsx:181` truncated to `slice(0,4) + "..."`, rebuilt | RED naming the element | **RED** — `span.file-name (… > td:nth-of-type(1) > span:nth-of-type(1)) [ambiguous-source]` |
| M5 | full container suite, mutation reverted | 96/96 | **96 passed (4.0m)** |

M4 reported `[ambiguous-source]` rather than `[truncated-name]`: `"conf..."`
matched more than one fixture source, so the oracle declined to guess which was
truncated and reported the ambiguity as data. That is the designed behavior and is
better than a confident wrong answer.

Deleted-oracle check: no references to `accessibleName` remain anywhere in `src/`
or `tests/` beyond the new local finding array.

### Standing finding raised by this phase — the baseline is not a spec

`knownFindings.json` currently holds **610 findings**: 388 clipping, 222 contrast,
0 accessibleNames, 0 zeroSize. Every one is a real product defect that was
recorded and normalized rather than fixed. The ratchet detects CHANGE, not WRONG,
and it has been standing in for bug-fixing. Contrast severity, computed from the
recorded ratios:

- **0 of 222 pass WCAG AA.**
- 82 fall below 3.0 — failing even the relaxed large-text / UI-component threshold.
- The worst are 1.10:1, concentrated in `hc-light`.

Per-project counts show the asymmetry: `hc-light` 34-36 contrast findings vs
`hc-black` 11. Root-caused in the next section.

---

## Defect-fix campaign — Round 1 (groups A + B)

The baseline stops being a spec. 610 recorded findings were triaged into six
root-cause groups (123 element-clusters), computed against a git-HEAD snapshot of
`knownFindings.json` so a concurrent regeneration could not move the numbers:

| Group | Root cause | Findings | Clusters |
|---|---|---:|---:|
| B | commit-row message cell collapses to 0px | 252 | 44 |
| E | contrast below 3.0 | 100 | 17 |
| C | 320px-viewport-only | 88 | 18 |
| F | contrast 3.0–4.5 | 78 | 16 |
| D | clipping at both widths | 48 | 6 |
| A | HC theme fallback polarity | 44 | 22 |

Round 1 took **A + B** — the two with a single shared cause each.

### Counts — verified by independent set diff, not from the builder's report

| Bucket | Before | After | Delta |
|---|---:|---:|---:|
| clipping | 388 | 208 | **−180** |
| contrast | 222 | 162 | **−60** |
| accessibleNames | 0 | 0 | 0 |
| zeroSize | 0 | 0 | 0 |
| **TOTAL** | **610** | **370** | **−240** |

**Added keys: 0.** The two-way ratchet taxes improvement — a fix turns the suite
red until the baseline is regenerated — so acceptance requires per-bucket counts
to FALL with zero keys added. Both held. Removals land where the triage
predicted: all 180 clipping removals in `undocked` + `commit-graph-card`, 48 of
the 60 contrast removals in HC themes.

### Group B — the count is the weaker evidence

Direct measurement at 1200px, before vs after:

- commit-row message cell: **0px → 175px**
- zero-width text elements: **2 → 0**
- rows overflowing their container: **202/202 → 0**

Cause: a `flex: 1; min-width: 0` cell whose siblings are all `flexShrink: 0`
absorbs 100% of any width deficit and renders at 0px — no ellipsis, no signal.
Fix is the pure function `visibleMetaColumns` (`commit-list/styles.ts`), which
drops the date column below 350px and the author column below 228px, plus a
`minWidth: 48` floor on the message text. Five boundary tests
(`tests/unit/webviews/visibleMetaColumns.test.ts`), mutation-proven RED by
flipping `>=` to `>`.

### Group A — the builder's contrast number was wrong, corrected here

`rgba(15, 74, 133, 0.1)` read as opaque is dark navy; composited over `#ffffff`
it is `rgb(231, 237, 243)`. **Both sides must be composited before a ratio means
anything.** Recomputed ContextMenu selection pair:

| Theme | Before | After |
|---|---:|---:|
| hc-light | **1.11 FAIL** | **12.33 PASS** |
| hc-black | 6.44 | 9.79 |
| light-modern | — | 6.31 |
| dark-modern | — | 4.53 |

The build report claimed 6.44:1 and checked only hc-black — it never evaluated
hc-light, which is where the change is the large win.

### Gates — re-run here, not trusted from the report

`lint` rc=0 · `typecheck` rc=0 · `format:check` rc=0 · `build` rc=0 ·
`vitest visibleMetaColumns` 5/5 · **container suite 96 passed (4.0m), rc=0**, run
via `./tests/e2e/docker/run.sh` on the pinned image.

### Two findings this round raised

1. **Group C's real cause is worse than a column-width problem.** At 320px in
   `hc-light`, the undocked commit-list pane measures **25px wide** — the panel
   does not reflow at that viewport at all, leaving 2 collapsed text elements.
   Rounds 3–4 must treat this as a layout defect, not a truncation defect.
2. **`visibleMetaColumns` does not account for `CHECKS_COL_WIDTH`** (28 + 4
   margin). With the checks column enabled the message cell can fall below its
   120px floor — not to zero, and empirically 0 keys were added, but the
   threshold arithmetic is incomplete. Fold into round 2.

Remaining: **370 findings** — E (100), D (48), C (88), F (78).

## Act 3 — Build — Round 3 of the visual-defect campaign (clipping)

**Resolved tunables.** `BUILD_MODEL=gpt-5.6-luna`, `BUILD_EFFORT=xhigh` (the
skill's only effort; `max` deliberately unused), `SANDBOX=danger-full-access`,
`MAX_FIX_ROUNDS=2`, `SEAL_MODE=shadow`, `GATES_FILE=.claudex-gates.json`
(gates: lint, typecheck, format, knip, architecture, suite),
`SPEC_FILE=<scratchpad>/SPEC-round3-clipping.md`, `LOG_FILE=PLAN-REVIEW-LOG.md`.
`BASE_HEAD=fcc88eb6dc76041911530837da58afc33c8b8e89`.

Protocol bytes pinned at kickoff:

    SKILL-SHA 9961facee66f  claudex-build/SKILL.md
    SKILL-SHA ca2ed5fd0f9e  claudex-build/helpers.py
    SKILL-SHA db9282d4db13  claudex-build/verify.py

**Mode deviation, logged.** The skill defaults to phase-lane mode at >=2 phases.
This run uses classic in-root mode: the session-level standing instruction is not
to spawn agents unless requested, and two phases sits at the low end of the
phase-lane threshold. The skill-mandated phase verifier still runs — that agent
is part of the contract the user invoked, not an optional extra.

### The measurement that produced this spec

The clipping baseline records only an element id per finding — no axis, no pixel
loss, no clipping ancestor. Fixing from the baseline alone would have been a
guess: horizontal loss means a width/shrink problem, vertical means a fixed
height, and the two have opposite fixes. A throwaway diagnostic
(`tests/visual/_diag.spec.ts`, deleted before launch, never committed) dumped
axis + lostPx + clipper for every finding on `dark-modern-narrow` (320x720) and
`dark-modern-wide` (1200x800).

Two results changed the plan:

1. **No finding is clipped by the viewport.** Every one has a real
   `overflow:hidden` ancestor doing the clipping. "320px is simply too narrow"
   was never the explanation.
2. **Six defects reproduce at 1200px.** `span.hunk-action-glyph` loses 2.3px
   vertically and two undocked toolbar buttons lose 98.0px and 78.0px
   horizontally at BOTH widths — column-width bugs, not viewport squeeze.

Deduplicated: 208 raw findings across 4 themes = **52 distinct defects**, every
one present in all four themes (pure layout, never colour), collapsing to ~10
root causes. Split into two phases by code surface — Phase 1 merge-editor family
(25 defects), Phase 2 commit-graph + undocked (27).

### Round 3.1 — Codex build, Phase 1 (gpt-5.6-luna / xhigh)

**SID: 019feb03-1979-7923-989f-1d2c2a4adbd3 — INIT-HANG, killed, no bytes written.**

Watcher alerted on the documented init-hang signature. Six-signal corroboration,
all agreeing, before any kill:

| Signal | Reading |
|---|---|
| rollout mtime | frozen 31 min (10:31 -> 11:02) |
| rollout size | flat at 18824 bytes |
| token events | 0 — never produced one |
| worktree mtimes | nothing newer; `git status` clean |
| codex CPU TIME | 0:00.04 cumulative after 31 min |
| stderr | only the cosmetic `failed to load models cache` line |

Stream stopped at 418 bytes immediately after `turn.started`. Zero token events
means the turn never reached the API, so this was session init, not slow
reasoning.

Environment cleared by smoke test — `codex exec` at `-c
model_reasoning_effort=low` returned `OK` in seconds, both with the full 11-server
MCP config and with `-c mcp_servers="{}"`. So neither Codex nor MCP startup was
broken, and the `--disable multi_agent` flag was not colliding with the
`[features.multi_agent_v2]` table (`--disable X` maps to `-c features.X=false`,
a different key).

Remaining difference isolated to the launch pipeline: the hung attempt piped
`--json` through `| tee "$STREAM" | grep '"type":"thread.started"'`. Relaunched
fresh, byte-identical prompt/model/effort/sandbox, with the stream redirected
straight to a file and the SID extracted from that file afterwards.

`SID(prev) 019feb03-1979-7923-989f-1d2c2a4adbd3 -> SID(new) see below.`

### Round 3.1 (relaunch) — Codex build, Phase 1 (gpt-5.6-luna / xhigh)

**SID: 019feb21-7e91-7d81-95ff-452752c2113b — completed, 37-line diff.**

`SID(prev) 019feb03-1979-7923-989f-1d2c2a4adbd3 -> SID(new) 019feb21-7e91-7d81-95ff-452752c2113b.`

Telemetry: `PEAK=244291 LAST=71843 PCT=94% NONRESUMABLE=yes`. `LAST` under half of
`PEAK` means the session compacted. 94% against a 45-50% target says Phase 1 was
oversized as specified — logged so Phase 2 gets sliced smaller, not as a defect in
the diff.

**Root verdict: REJECT on one CRITICAL, accept the rest.** Root reviewed the whole
diff rather than sampling it, which is the only reason the CRITICAL was caught:

    [CRITICAL] merge-editor.css — `.code-line-content { overflow:hidden;
    text-overflow:ellipsis }` plus `.code-line-content span { display:inline-block;
    max-width:100%; overflow:hidden; text-overflow:ellipsis }`.

This truncates source code inside a merge editor. `.code-lines` is a `max-content`
grid with `overflow-x: auto`, scroll-synced to the synthetic
`.merge-horizontal-scroll` bar by `MergeEditorApp.syncHorizontalScroll`
(MergeEditorApp.tsx:321-325, 511, 531). Ellipsising the row defeats that scroller
and strands the bar with nothing to scroll — the user loses the right-hand side of
every long conflict line with no way to reach it. The `display: inline-block` on
every syntax-highlight token additionally breaks inline text flow. It violated
FORBIDDEN #2 and #3 of the spec verbatim: it made the measurement pass by hiding
the measured content.

Kept from the same diff, all genuine: `.merge-toolbar` / `.toolbar-left` /
`.toolbar-right` wrapping, `.toolbar-btn` `height:auto; min-height:24px;
min-width:0; white-space:normal`, `.hunk-action-glyph` `line-height: 1 -> 20px`,
`.action-btn` `height: 20px -> 24px`, the `.conflict-table` cell ellipsis rules,
and the `title` attribute on the theirs column.

Report gaps, logged: the container check in the report ran BEFORE the glyph and
span patches and was never rerun, so 17 of 25 findings had no container evidence
behind the claim; an "Exact clipping oracle — 8 pass" line named no file that
exists in the tree.

### Round 3.2 — root takeover (no fix round spent)

The remaining work was (a) reverting a known-bad CSS block and (b) an oracle change
under `tests/`, which the spec forbids Codex from touching. A fix round would have
been a ~30-minute, ~240K-token work order that reads "revert your own change and do
nothing else", so root finished Phase 1 directly. Deviation from the skill's
fix-round ladder, logged here rather than taken silently.

**The spec was partly wrong, and the evidence says so.** Spec deliverables 4 and 5
(9 findings on `.code-line` / `.hunk-line` spans) are oracle false positives, not
product defects. Two independent facts:

1. They vanish at 1200px — `merge-editor` on `dark-modern-wide` reported ZERO
   findings — while the genuine defects (glyph 2.3px, chakra 98.0/78.0px) persist
   at both widths. Width-dependence is the discriminator.
2. `.code-lines` is a scroller. Content that overflows a scroller is reachable;
   the outer `overflow:hidden` ancestors bound the scrollport, not its contents.

The collector had no concept of a scrollable ancestor, so it counted every clipper
above the scroller. Fixed in `collectOracleInputs.ts`: axis-scoped `scrolledX` /
`scrolledY` flags, set as the walk crosses a scroller and evaluated AFTER that
ancestor's own clip test (so an ancestor that scrolls X while hiding Y still clips
Y at its own box), plus the same reasoning applied to the viewport bounds.

**Mutation-proved, not asserted.** An exemption with no falsifying case is
unfalsifiable, so `clippingCollector.spec.ts` gained three control cases and the
production collector was mutated inside the container to check they can go red:

| Case | Exemption present | Exemption disabled |
|---|---|---|
| `scrollerChild` (scroller inside `overflow:hidden`) | `[]` | `["horizontal"]` |
| `noScrollerChild` (same DOM, `auto` -> `hidden`) | `["horizontal"]` | `["horizontal"]` |
| `scrollerVerticalClip` (scrolls X, hides Y) | `["vertical"]` | `["both"]` |

`noScrollerChild` is the load-bearing one: byte-identical DOM with one CSS value
flipped, opposite verdict. Without it the exemption could have been silently
swallowing every nested clip and still looked green.

### Phase 1 evidence — one container run, three passes

`./tests/e2e/docker/run.sh` on the pinned `linux/amd64` image.

    PASS1_RC=0   clippingCollector.spec.ts, exemption present   -> 8/8 green
    PASS2_RC=1   same spec, production collector mutated        -> 8/8 red
    PASS3_RC=1   nonPixelOracles.spec.ts vs the 208 baseline    -> 20/64 red, all `resolved`

PASS 2 mutated `collectOracleInputs.ts` in place (`scrolledX ||=` -> `scrolledX =
false &&`, same for Y), reran, and restored it — the exemption's own kill switch,
exercised against the production file rather than a copy. The failure diff named
exactly the two intended cases and nothing else:

    -   "scrollerChild": Array [],
    +   "scrollerChild": Array [ "horizontal" ],
    -   "scrollerVerticalClip": Array [ "vertical" ],
    +   "scrollerVerticalClip": Array [ "both" ],

`noScrollerChild`, `ellipsisSelf`, `ellipsisChild` and `verticalClip` were
byte-identical in both passes, so the exemption is not swallowing clips in general.

**PASS 3, both directions of the ratchet:**

| Direction | Count |
|---|---|
| `regressions` (observed, not baselined) | **0** across all 64 theme x host runs |
| `resolved` (baselined, no longer observed) | 31 per theme x 4 themes = **124** |

Per theme: `undocked` 6 + `merge-editor` 7 + `shelf-conflict-editor` 12 +
`merge-conflict-session` 2 at narrow, `shelf-conflict-editor` 4 at wide. Identical
in all four themes, which is the same pure-layout signature the diagnostic found.

**Baseline: 208 -> 84.**

Attribution of the 25 distinct resolved selectors — every removal traced to a
specific change, none unexplained:

| Cause | Selectors | Kind |
|---|---|---|
| `.toolbar-btn` fixed height in an unwrappable row | 3 `button.toolbar-btn.subtle*` | product fix |
| 22.5px glyph in a 20px button | 4 `span.hunk-action-glyph` | product fix |
| `.conflict-table` theirs column at `width:22%` | `th:nth-child(3)`, `td:nth-child(3)` | product fix |
| merge/shelf code spans inside `.code-lines` | 9 bare `span` | oracle false positive |
| undocked header spans inside a scroller | 6 `span.css-*` | oracle false positive |

**The undocked removals were not intended and were checked before being accepted.**
Nothing in Phase 1 touched `undocked`, so the 6 there came purely from the oracle
change. Two independent facts say they were never defects:

1. All six appear ONLY in the four `*-narrow` buckets of the baseline — never in a
   `*-wide` one. Width-dependence is the discriminator: a real layout bug survives
   1200px, content-too-long-for-a-narrow-pane does not.
2. `undocked` at wide stayed GREEN, so the two chakra toolbar buttons that lose
   98.0px and 78.0px at BOTH widths are still baselined. The exemption left the
   genuine undocked defects exactly where they were — it is discriminating, not
   blanket. Those two remain Phase 2's work.

### Gates and acceptance — Phase 1

    round stage:  lint OK 12.1s | typecheck OK 4.6s | format OK 2.8s
    accept stage: knip | architecture | suite   (see below)

Phase 1 accepted and committed. What it did NOT do, stated so the next phase does
not inherit a false picture:

- The two undocked chakra toolbar buttons (98.0px / 78.0px horizontal loss at BOTH
  widths) are untouched and still baselined. Phase 2.
- The shared commit-row span at exactly 12.0px across `commit-graph-card` and
  `commit-graph-compact` (10 findings, one component) is untouched. Phase 2.
- `.toolbar-center` did not get `flex-wrap`; only `.toolbar-left` and
  `.toolbar-right` did. Nothing in the baseline reported a clip there, so it was
  left alone rather than changed on speculation.
- The `ellipsisSelf` gap is still open — an element that carries
  `text-overflow: ellipsis` is dropped from the clipping list on BOTH axes, so a
  vertical clip on such an element is invisible to the oracle. Encoded as an
  assertion in `clippingCollector.spec.ts`, tracked, not fixed here: fixing it
  ADDS findings, which belongs in its own change.

**Ledger.**

    610 -> 370  round 1 (60d84ea9)
    370 -> 346  exemption: 24 never-defects (dd4e0d82)
    346 -> 248  contrast tokens: 98 real fixes (4e2207b7)
    248 -> 208  line-number gutter: 40 real fixes (84aa2ec8)
    208 -> 208  ancestor-ellipsis oracle fix (fcc88eb6)
    208 ->  84  round 3 phase 1: 9 product fixes + scrollable-ancestor exemption

## Round 3 — Phase 2 (pane budget, toolbar wrap, checks-column budget)

Builder: Codex `gpt-5.6-luna` @ xhigh, fresh session
`SID = 019feb67-311f-7030-81b1-ebb574f23633`, `BASE_HEAD = aa73ced5`.

### What the build delivered, and what its own checks missed

Codex reported 7/7 DONE with typecheck/lint/format green. It ran **three** test
files — the ones it touched. The full suite had **4 failures in 2 files**, and
the RED evidence for the new module was an import error ("collection failed
because `paneBudget.ts` was missing"), which demonstrates nothing about the
assertions. Root findings, all fixed here:

1. **`paneBudget` tests were blind to deleting every input guard.** Mutation
   proof over production bytes: 5 mutations, **1 stayed green** — replacing
   `finiteNonNegative` with a passthrough. The degenerate-input test dropped its
   non-finite pane before it could receive a width, and asserted finiteness of a
   survivor that was `0` by construction. Added two cases (a poisoned pane that
   stays visible; a negative viewport). Re-proof: **0/5 blind**.
2. **Divider drag stopped tracking the mouse.** The build split persisted
   preferences from the rendered projection but left the drag delta in preference
   space. At `innerWidth=1800` the projection scale is `1784/1184 = 1.5068`, so a
   20px drag moved the boundary `20 x 1.5068 = 30.13px` (observed 283.27 vs
   expected 273.14). It had orphaned `sectionWidthsAreClose`, the guard that kept
   the two spaces identical. Restored and re-wired, gated on
   `hidden.length === 0` so preferences survive a narrow viewport intact.
3. **The panel collapsed to nothing whenever width read 0.** A `0` budget means
   "nothing fits", so an unmeasured shell hid every pane — permanently where
   `ResizeObserver` is absent. Now: measure before the guard, `useLayoutEffect`
   to avoid a one-frame blank, and treat `shellWidth <= 0` as "not measured yet"
   by rendering the preferred layout. The commit list flexes rather than taking a
   resolver width (equivalent once measured, correct before).
4. **Two dead exports** (`sectionWidthsAreClose`, `SECTION_DROP_ORDER`) — caught
   by knip, an accept gate the build never ran.
5. **`visibleMetaColumns(_, false)` was untested** — every case passed `true`,
   leaving the branch that must preserve the old 228/350 thresholds unmeasured.

Out-of-spec file `useUnifiedMessages.ts` (+24/-24) reviewed and **kept**: it is a
forced consequence of `normalizeSectionWidths` changing return type, not scope
creep. `resizeSectionPair`'s minimum-scaling was reviewed and **left alone** — its
pair total is genuinely over-subscribed, and it now edits preferences that the
true-minimum resolver re-projects, so it can no longer collapse the render.

### Evidence

    mutation proof:   5 mutations, 0 blind (was 1/5)
    unit+integration: 224 files / 3341 tests passed
    accept gates:     typecheck OK 4s | lint OK 11s | format OK 2s
                      knip OK 1s | architecture OK 1s
    container:        UPDATE_RC=0 112 passed (4.1m)
                      VERIFY_RC=0 112 passed (4.1m)   <- two-way ratchet

### Baseline: 84 -> 0, and what that number is not

**0 findings is not 84 defects repaired.** The honest split:

- **8** sat in wide buckets, where no pane is ever dropped. Those can only have
  gone away through a real fix (the toolbar wrap). Definitive.
- **~40** are `CommitRow` message cells that still render and now have real
  width. Previously measured at `w=0` (clipper `{left:308, right:308}`).
- **~32** are no longer *measurable* because their pane is now intentionally
  dropped at 320px. The clipping oracle cannot see an element absent from the
  DOM. This is measurement loss, not repair.

Consequence to state plainly: the undocked window at 320px now renders **only the
commit graph** — repository, commit panel, branch and info panes are dropped. That
is the specified `dropOrder` behavior and beats five unusable 60px slivers, but it
is a real UX change, and it is why part of the delta is not a fix.

The `ellipsisSelf` gap remains open and still under-reports: in the formerly
zero-width cells the commit message was clipped too, invisible only because it
carries `text-overflow: ellipsis`. Fixing it ADDS findings; its own change.

**Ledger.**

    610 -> 370  round 1 (60d84ea9)
    370 -> 346  exemption: 24 never-defects (dd4e0d82)
    346 -> 248  contrast tokens: 98 real fixes (4e2207b7)
    248 -> 208  line-number gutter: 40 real fixes (84aa2ec8)
    208 -> 208  ancestor-ellipsis oracle fix (fcc88eb6)
    208 ->  84  round 3 phase 1: 9 product fixes + scrollable-ancestor exemption
     84 ->   0  round 3 phase 2: ~48 real fixes + ~32 dropped-pane measurement loss
