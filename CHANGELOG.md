# Changelog

All notable changes to IntelliGit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.26.0] - 2026-08-19

### Added

- Added an "Open Repository" action that opens the repository's page on its forge in the browser. It sits beside sync, fetch, pull and push in both toolbars that carry them — the Graph view's title bar and the Commit panel's tab bar — and is also available from the Command Palette. The remote is read from `origin`, falling back to the first configured remote so forks and mirrors whose only remote is named something else still work. Host detection is by URL shape rather than by hostname, so self-hosted GitLab, Gitea and Bitbucket Server instances are supported alongside the SaaS forges, across the scp-like (`git@host:owner/repo.git`), `ssh://`, `git://` and `https://` remote forms. Credentials embedded in a remote are stripped before anything reaches the browser: a URL cached by a credential helper carries the token in it, and handing that to the browser would write it into history and the referrer chain. An SSH port is dropped rather than carried onto the web URL, where it would address the wrong daemon; an explicit port on an `https://` remote is already a web port and is kept.

## [0.25.12] - 2026-08-18

### Security

- Stopped the GitHub commit-check path posting an unredacted error into webview state. The three other providers already strip their stored token from error text before it reaches a snapshot, for the reason their shared normalizer documents: a transport, proxy, or SDK error may echo a request header verbatim, and the error type carries the first 200 bytes of the response body. GitHub did not, so an intercepting proxy whose error page reflects the request would put the user's token into the snapshot and from there into webview state.

### Added

- Added the commit-check badge refresh to the Command Palette. The command was registered but never contributed, which is invisible from the outside — the palette simply does not list it, and nothing fails. It is the only recovery a stuck badge has short of reloading the window, since it drops both the cached snapshots and the per-origin rate-limit buckets. It is now listed in every activation mode, so opening it without a repository explains itself instead of answering "command not found".
- Added a "Sign in" action to a GitHub badge whose session has been rejected. The other three providers already offered one; GitHub posted a bare error, so a revoked session, or a token an organization never authorized for SSO, left a dead-end badge whose only recovery was reloading the window. Sign-out for github.com also stops claiming it cleared a token — deleting a key that was never written succeeds, so the confirmation used to report a sign-out that had not happened while the built-in session stayed live.

### Changed

- Commit-check badges now appear about ten times sooner after a push. Both retry ladders opened at 30 seconds, so a commit whose CI was still pending — the common case immediately after a push — showed nothing for half a minute. They now open at 3 seconds and back off from there, and the pending ladder gained rungs so its total coverage still spans a real CI run.
- A viewport's commit checks are now fetched concurrently. The per-viewport loop awaited each hash in turn, so a 30-row viewport serialized 30 round trips and could never use the shared gate's existing allowance of four concurrent requests per provider origin.
- Providers that advertise their own rate limit are no longer held to the fallback cap of 300 automatic requests an hour. On GitHub that is roughly 6% of a 5000/hour budget, and since each commit costs two REST calls, a few repositories open at once exhausted the self-imposed cap and surfaced a cooldown the real quota was nowhere near. Bitbucket Server parses no quota at all and Bitbucket Cloud reports only a near-limit flag, so for those the cap remains the only guard.

### Fixed

- Fixed a repository switch pinning commit checks to the previous forge. A provider resolution suspended across the switch would complete afterwards and record the previous repository's provider and ref, and because that write also set the resolved flag, every later fetch reused it — querying the old forge with the new repository's commit hashes and caching the answers under the wrong key. Fetching a viewport concurrently is what made this routine rather than rare, since a coordinator previously had at most one resolution in flight at a time.
- Fixed a commit alternating between states polling forever. Per-hash retry bookkeeping reset its attempt counter whenever the snapshot state changed, so a commit flipping between pending and none re-armed the first rung on every transition: a sustained three-second poll, two HTTP calls per tick on GitHub, for as long as the alternation lasted. Reaching it needs no attacker — an intermittently failing GitHub endpoint empties the item list, and the aggregate then reads none for one poll and pending the next.
- Fixed a server's own numbers being able to unbound or park a rate-limit bucket. A reset header of `1e306` seconds is finite but overflows to Infinity once converted to milliseconds, and satisfied "the reset is in the future" forever; a bucket exempt from the cap had no request ceiling at all, leaving a cooldown computed entirely from server-supplied numbers as its only quantity guard; and a cooldown taken literally could park a bucket for a full day. Granting the bypass now requires a reset inside a day, cooldowns clamp to one request window and re-arm from the next response if the provider still wants more, and an exempt bucket's ceiling follows the advertised limit.
- Fixed the GitHub quota bypass being granted on a quota no server ever advertised. The limit, remaining and reset fields are each remembered independently, so a response carrying only a limit and a later one carrying only a remaining and a reset combined into a tuple that lifted the automatic ceiling from 300 requests an hour to the full advertised 5000. The bypass is now judged on a single response's own headers. The reserve cooldown deliberately still reads the remembered fields, because a raised ceiling is a permission and has to be earned outright, while a cooldown is a brake — withholding one from a response that proves the quota is nearly spent, merely because that response omitted the limit header, would fail in the unsafe direction.
- Fixed signing in to a rejected GitHub session reporting success while changing nothing. The recovery asked for an existing session, which returns the very session GitHub had just rejected without prompting, so the user saw "Signed in to github.com." and a badge that failed again for the same reason. It now forces a fresh consent flow.

## [0.25.11] - 2026-08-18

### Fixed

- Fixed the Commit panel coming up permanently blank while the Graph beside it filled in normally. When the panel loads it announces itself, IntelliGit answers with the list of repositories, and the panel keeps re-asking until that answer arrives. IntelliGit sent the answer to whichever panel it had recorded last, rather than to the panel that had just asked. It forgets that record when the view is closed, and the panel can be reloaded without IntelliGit being told — so once the two disagreed, every answer went nowhere. Nothing reported it, because sending to a panel that is not open is an ordinary thing to do and is not treated as a fault, so the panel re-asked for as long as the window stayed open and stayed empty throughout. A panel that has just sent a message is by definition there, so IntelliGit now treats it as the panel to answer whenever it is holding no record of one — while leaving an existing record untouched, so a panel that has since been replaced cannot take answers meant for the one actually on screen.

## [0.25.10] - 2026-08-18

### Fixed

- Published 0.25.9, which was built and then never released. A test covering how IntelliGit writes the marker that names the window currently changing a repository was checking the wrong thing: it identified the marker file by a number the operating system is free to hand out again once a file is gone, and every renewal of the marker releases the previous one. On Linux that number came straight back, so the test's verdict depended on how many renewals happened to fit in the moment it waited — it passed twice and then failed, which stopped the release. It now holds the file open and checks that the renewal leaves it untouched, which is the behaviour that actually matters. Nothing in the extension itself changed between the two versions.

## [0.25.9] - 2026-08-18

### Fixed

- Fixed shelf and repository actions refusing to run — permanently — after a crash left a damaged marker file behind. IntelliGit marks a repository as busy while it is changing it, and clears the mark when it finishes. If the extension died at the exact moment that mark was being rewritten, what it left behind could no longer be read. A mark that cannot be read names no owner, and IntelliGit treated that the same as one belonging to a process still working, so it waited for an owner that was never coming: every later shelf action reported the repository as busy, and no amount of waiting, retrying or reopening the window cleared it. Only deleting the file by hand did. An unreadable mark is now judged by when it was last written, exactly as a readable one is judged by its owner's last sign of life, and is cleared once nothing has touched it for thirty seconds. A mark that has only just appeared is left alone, so this never interrupts a window that has just started working.
- Fixed two windows being able to change the same repository at the same time when one of them stalled. IntelliGit refreshes its busy mark every few seconds, and it used to do that by emptying the file and then writing the new mark into it. A window frozen between those two steps — by a long operation, or by the machine being under load — left the mark empty for as long as the freeze lasted; an empty mark names no owner, so a second window could conclude the first was gone and take the repository over while it was still working. The mark is now written elsewhere and swapped into place complete, so it can never be seen half-written: a stalled window is still recognised as the owner and is left alone. A window that is interrupted before its own mark lands now checks the mark back before it starts, so it cannot go on believing it holds a repository that has since been handed to someone else.
- Fixed a repository being taken over from a window that was in fact still working. Before taking a repository over from a window that appears to have abandoned it, IntelliGit checks that the mark it is about to displace is still the one it examined. That check recognised a mark by its owner alone — and a window keeps the same owner for as long as it runs, so a window that renewed its mark in the moment between the examination and the takeover still looked unchanged and was displaced anyway. Renewing the mark is precisely the sign that the window is alive, and it is now part of what the check compares, so a repository is left alone whenever its owner renews the mark while a takeover is being decided. This could only arise where IntelliGit cannot see for itself whether the owning window is still running — a repository on a network share, or one open on another machine — because everywhere else it asks the system directly.

## [0.25.8] - 2026-08-18

### Fixed

- Fixed the extension stopping altogether when a Git command finishes before it has been given all of its input. Only the command itself was watched for failure, never the channel used to feed it, and a failure on that channel is not one the surrounding code is able to catch — so rather than that single command reporting a problem, everything came to a halt. Nothing is lost by ignoring that particular failure: the command's own exit status and error output already describe what happened. Any other failure to hand over the input is still reported, because a Git command finishes successfully on however much of its input it managed to read — so ignoring those too would have turned a command that ran on half its input into one that appears to have worked.
- Fixed the list of shelves failing outright instead of waiting whenever a shelf operation was already under way. Reading the list does not pass through the queue that shelf changes pass through, so it met a change in progress head-on and gave up at once, and the commit panel quietly showed the shelves it had last seen instead — stale contents, with nothing reported as wrong. A read now waits up to a second for the change to finish instead of giving up at once, and reports the store as busy only if it is still held after that. The wait is kept short on purpose: this read runs as part of the commit panel's periodic refresh, alongside the working-tree status and branch information, so a longer one would hold up everything else on the panel to little benefit.

## [0.25.7] - 2026-08-17

### Fixed

- Fixed a release that is waiting to publish holding up the checks on every change merged after it. The build, the visual suite and the end-to-end suite shared a queue with the publishing step, and because a release is deliberately never interrupted once it starts, anything merged behind one simply waited — in the case that prompted this, for thirteen hours, after which the change queued in between was dropped without reporting a failure. Releases still publish strictly one at a time; they no longer make anything else wait for them.
- Removed the manual approval a release had to be granted before it could publish. It gated nothing that the automated checks above it did not already gate, and an approval nobody clicked was what stalled the queue described above.
- Fixed a release being dropped when two further changes are merged while it is still publishing. Publishing is deliberately done one version at a time, but only a single release could wait its turn: a third merge silently cancelled the one waiting in between. Because the step that decides whether to publish reads the version on the newest commit, a version skipped that way was never reconsidered and simply never shipped — which is how 0.25.2 came to have no release. Up to a hundred releases now wait in line and publish in the order they were merged.

## [0.25.6] - 2026-08-17

### Fixed

- Fixed all four webview views throwing away the result of every message they send. VS Code answers a send three ways — delivered, accepted but not delivered, and failed outright — and each view discarded the answer, so a view that never received what it was sent looked, from the extension's side, exactly like one that did. This is the missing half of the blank commit panel addressed in 0.25.4: that release made the panel keep asking until it gets an answer, but when an answer never came there was no record anywhere of which direction the message was lost in, and the report left behind by a failed run could say only that the panel was empty. A send that does not land is now recorded with the view that sent it and the message that was lost.
- Fixed a failed send to a closed view surfacing as an unhandled promise rejection inside the extension host — a crash report about a message the user never needed to know had a promise behind it. The same send failing on the spot rather than asynchronously could also interrupt whatever the extension was doing at the time, including displacing an error that was in the middle of being reported.

## [0.25.5] - 2026-08-16

### Security

- Updated Vitest to 4.1.10 and esbuild to 0.25.12, closing two advisories that stood against the versions this project had pinned: a critical one where a listening Vitest UI server could be made to read and execute arbitrary files, and one where any website could issue requests to an esbuild development server. Both are development-time only and neither reaches a published extension, but both had been open with no proposal able to fix them — see below for why.
- Fixed Dependabot being unable to propose any dependency update this repository could merge. It was configured for the `npm` ecosystem while every job installs from `bun.lock` with a frozen lockfile, and the npm ecosystem edits `package.json` without writing that lockfile — so each proposal arrived with the two out of step and failed the install before a single test ran. Five open proposals, none of them mergeable by anyone, including the ones that would have closed the advisories above. It now uses the `bun` ecosystem, which updates the manifest and the lockfile together.
- Fixed every GitHub Actions version bump arriving permanently red. A test asserted the exact commit SHAs it was bumping, and Dependabot cannot edit that test in the same pull request, so the cheapest route to a green branch was to stop bumping — the opposite of what pinning is for. The pinning guarantee itself was never what those lines proved and is unchanged: a separate sweep still requires every action reference in the workflow directory to be a full commit SHA. What replaced them asserts instead that `codeql-action/init` and `analyze` remain on one commit, which is the failure an exact SHA could never tell apart from a correct bump.

## [0.25.4] - 2026-08-16

This release also carries everything listed under 0.25.2 and 0.25.3, neither of which ever reached the marketplace — the release-pipeline defect fixed below is the reason, and it would have swallowed this release too.

### Fixed

- Fixed the release pipeline silently skipping every publish. Two defects compounded. Runs were grouped so that a push to `main` cancelled the release still in flight from the previous merge, and a cancelled run reports no failure, shows no red cross and notifies nobody; `main` pushes now queue, while pull-request runs still supersede each other. Worse, the gate that decided whether to release compared `package.json` against the previous commit, which asks "did this commit bump the version" — a question that can never recover from a run that failed to reach it. Once 0.25.2's run failed and 0.25.3's run was cancelled, both bumps were orphaned and every later commit correctly reported "unchanged" and skipped, permanently and silently. The gate now asks whether the current version already has a GitHub Release, so a missed run is repaired by the next commit to land rather than stranding the release for good.
- Hardened that same self-healing path against republishing a version that already shipped. A run that reached a marketplace but died before creating its GitHub Release looks, to the gate above, exactly like one that never published at all — and the repair would then upload freshly rebuilt bytes under a version someone has already installed. Publishing now refuses that case and says which half already shipped, so a partial release fails loudly and is recovered from its original artifact instead of being quietly replaced.
- Fixed the commit panel intermittently rendering nothing at all. The panel's only route to content is a single `ready` message answered by a single repository list, and neither leg is acknowledged — VS Code drops messages to a webview that is not live, and its API contract states that even a successful send does not mean the message was received. One dropped message in either direction therefore left the panel permanently blank: React mounted, no repositories, no empty state, no error and nothing to retry it. The request is now repeated for as long as it goes unanswered, quickly at first and then as a slow heartbeat, and stops the moment the host replies — including when the reply is an empty repository list. It does not give up: a panel that stops asking has no other way back to content, because the messages sent when a view becomes visible again carry the working tree but never the repository list the panel is waiting for. Each request is numbered so the host can answer a repeat from state it already holds instead of repeating the startup Git reads, which is what makes waiting indefinitely affordable.
- Fixed the commit panel losing its state every time it was hidden, for workspaces that gained their first repository after startup. `retainContextWhenHidden` is fixed when a view is registered and cannot be added afterwards, and only one of the activation paths that register the panel was passing it.
- Fixed the end-to-end gate that guards a release running only after the merge that needed guarding. The job the release chain waits on was restricted to `main`, so it reported "skipping" on every pull request and first executed once the change was already in — which is how a green pull request was followed by a red `main` and a release that never went out. It now runs on pull requests against `main` as well, and the second workflow that had been running the identical suite in parallel without gating anything was narrowed to the pull requests this one does not see, so the same suite no longer runs twice per event.
- Fixed that gate itself failing intermittently on a race rather than on a defect. Toggling the editor panel open starts a terminal, which takes keyboard focus a moment later, and VS Code dismisses the command palette whenever it loses focus — so the palette could disappear with its filtered command list already on screen, leaving the test driving an element that was still present and no longer visible until it timed out. Driving the palette now re-opens it and starts over when it goes away, bounded, instead of waiting out an element that is never coming back.

## [0.25.3] - 2026-08-16

### Fixed

- Fixed the merge editor's and shelf conflict editor's hunk action arrow still clipping at the top and bottom, where an action row sits flush against the top of a scrolling area. Raising the button to 24px in 0.25.0 was not enough: a text range's client rectangle is the font box, not the line box, so a 22.5px glyph measured 29px tall and kept overhanging its button. The glyph is now sized so its font box fits inside the button on any font. The recurrence was invisible until the test fixtures were pinned to the container platform — `--vscode-editor-font-family` resolves to Menlo on macOS and Droid Sans Mono on Linux, and the two platforms' row metrics differ enough to hide it.

### Added

- Added release-package verification, SHA-256 artifacts, dual-version installed-package smoke coverage, and a weekly cross-platform installed-package portability sweep.
- Added a nightly staleness sweep over the committed VS Code host fixtures, one pinned editor launch per fixture, so drift in what those fixtures record surfaces on its own rather than as an unexplained failure somewhere downstream. It reports through the same single aggregated nightly issue.

### Security

- Added least-privilege CodeQL and dependency-review workflows, provenance attestation for the exact release VSIX, and Dependabot coverage for root Bun dependencies.
- A release published through the `skip_e2e_gate` override now records that override on the created GitHub Release itself. Recovery refuses to replace an existing release or marketplace version with rebuilt bytes, preventing one version from naming different packages across destinations.
- Every GitHub Actions reference in every workflow is now held to a full commit SHA, and a checkout may leave the workflow token in `.git/config` only in the job that pushes the release tag, by a guard that reads the workflow directory rather than a list of remembered files. The nightly staleness job above had reintroduced both — a floating tag and a persisted credential — because the controls were applied by sweep and nothing enforced them.

## [0.25.2] - 2026-08-15

### Added

- Added an end-to-end suite that exercises the mutating git operations — staging, committing, branching, shelving, conflict resolution — against a seeded fixture repository inside the same digest-pinned Linux container the visual suite uses. Each flow is checked against git itself rather than against the UI's own report, so a panel that renders the right thing after doing the wrong thing still fails. A small, high-value set runs on every pull request and gates releases; the full sweep runs nightly, sharded, with a single aggregated failure report that reuses the issue it already opened instead of filing one per shard per night.
- Added a non-gating nightly run against VS Code Insiders, so an upcoming change to the editor surfaces here before it reaches a release.

### Fixed

- Fixed the extension's development-only E2E control channel losing any request that arrived before its watcher attached. Filesystem events were being relied on as the delivery guarantee rather than as an optimisation; delivery is now reconciled by polling, requests already present at activation are drained, and a readiness marker gives clients something to wait on instead of an unexplained timeout.
- Fixed an unreadable request on that channel being discarded with nothing written to the host log, which left the caller with a timeout and no stated reason for it. The report withholds the request body, which can carry a secret value, and is emitted once per request rather than once per poll.

## [0.25.1] - 2026-08-15

### Fixed

- Selecting a commit posted its detail to the webview twice: once raw, then again unconditionally once asynchronous icon-theme decoration settled. With no icon resolver attached, or whenever decoration changed nothing, that second message was byte-identical to the first and the pane re-rendered for nothing. The follow-up post is now sent only when the fully-built outgoing payload actually differs. The comparison is deliberately made on the payload rather than on the decoration result, because awaiting the icon theme can populate folder-icon and icon-font data for the first time between the two posts, and a guard keyed on "did decoration change the commit detail" would have silently dropped that legitimately new data. The first post to a given webview is always sent, so a restored view can never render empty.

## [0.25.0] - 2026-08-15

### Added

- Added an automated visual regression suite that renders the commit panel, commit graph, merge editor, shelf conflict editor and undocked views against Dark Modern, Light Modern, High Contrast Black and High Contrast Light, at both a 320px and a 1200px viewport, and checks each one for clipped text, sub-4.5:1 contrast and missing accessible names. It runs inside a Linux container pinned by image digest so a rendering difference between a contributor's machine and CI cannot pass as a product change, and it gates releases. Every fix listed below was found by it.
- Added a 12-locale sweep across the same screens, which renders the localized UI and fails on text that only clips once translated — the class of defect that is invisible in English.

### Fixed

- Fixed secondary, added and deleted text falling below the WCAG 4.5:1 contrast floor on selected and high-contrast rows throughout the commit panel, commit graph, merge editor and conflict session. Each token is now mixed toward the host foreground far enough to clear the floor while keeping its semantic hue.
- Fixed muted, added and deleted text rendering as an unreadable hardcoded colour in High Contrast Black and High Contrast Light. VS Code emits a CSS variable only for colours the active theme defines, so a `var(--vscode-…, #literal)` fallback made the literal the real value in exactly the themes that most need contrast.
- Fixed the merge editor's line-number gutter falling below the contrast floor where it sits on top of the conflict and deleted-block ribbons, which tint the background the gutter colour was chosen against.
- Fixed the commit row's message collapsing to zero width with no ellipsis and no other signal in narrow panels, because the message cell absorbed the entire width deficit from siblings that could not shrink. The date and author columns are now dropped as the panel narrows, and the message keeps a minimum width.
- Fixed the undocked commit graph rendering all five panes at unusable widths at any viewport instead of dropping the lowest-priority pane, so a 320px viewport now keeps the commit list readable rather than collapsing it.
- Fixed the merge editor and commit panel toolbars being unable to wrap, which cut the labels off `Continue Rebase`, `Abort Rebase` and three merge-editor buttons at narrow widths.
- Fixed merge editor and shelf conflict editor buttons clipping their labels in German, Spanish, French, Japanese, Korean, Polish, Brazilian and European Portuguese, and Russian. The toolbar and footer groups were pinned against shrinking, so the wrap that was supposed to handle overflow could never engage.
- Fixed the conflict table's "theirs" column cutting branch names and paths with no ellipsis and no tooltip. Header and data cells now truncate visibly and carry the full text as a tooltip.
- Fixed the hunk action arrow being clipped at the top and bottom in every theme, where a 22.5px glyph was rendered inside a 20px-tall button.
- Fixed the pane divider moving further than the pointer on scaled displays, because the drag delta was applied in preference space while the user drags in rendered space.
- Fixed the branch sidebar's section headers cutting their names off with no ellipsis and no tooltip in Spanish, Polish, Brazilian and European Portuguese, and Russian, where `Worktrees` becomes a name two to three times its English length. The header label could not shrink at all, so the branch column narrowing on a 320px viewport removed the end of the word outright; it now truncates visibly and carries the full name as a tooltip.
- Fixed the published extension shipping the `.codebase-memory` directory, removing about 1 MB from the package.
- Fixed the published extension shipping GitNexus's `graphify-out` analysis directory. Version 0.24.3 carried 12 of its files, `graph.json` alone being 8.7 MB, which took the unpacked package from 6.3 MB to 15.8 MB.

### Security

- The packaging guard that keeps E2E control-channel commands out of the published manifest is now actually run in CI, as the `verify:manifest` build step. It previously existed with no callers.

## [0.24.3] - 2026-08-14

### Fixed

- The shelf conflict editor showed English regardless of the configured display language: its window title, the "shelf conflict changed while this editor was open" prompt, and that prompt's two buttons. All five strings are now translated across the twelve shipped locales.

### Security

- The extension bundle now also carries the webview-capture boundary the automated UI tests record through. It is inert in every published install, gated by the same three-gate check as the control channel: with the gate off, each host receives its own webview object back unchanged and identity-equal, and no capture buffer is allocated. Captured messages are held in memory only and are never logged, because a captured message can carry real repository data.

## [0.24.2] - 2026-08-14

### Security

- The extension bundle now carries an end-to-end control channel used only by the automated UI tests. It is inert in every published install: it activates only when all three of `ExtensionMode.Development`, `INTELLIGIT_E2E=1`, and a writable channel directory hold at once, and a released extension never runs in development mode. It answers only an explicit allowlist of keys — anything unlisted is rejected rather than passed through — and it reports secrets as presence and digest, never as values.

## [0.24.1] - 2026-08-13

### Security

- The E2E container image now installs Bun from a checksummed release artifact instead of piping a remote installer into a shell. That image gates releases, and the toolchain it produces is then handed a read-write mount of the checkout and the build caches, so an unverified install script was running inside the build whose success is a precondition for publishing.

## [0.24.0] - 2026-08-04

### Added

- Added an opt-out marketplace rating prompt that appears at most three times, only after 30 successful commits or pushes across 5 active days and 14 days since install, and never again once answered. Ratings route to the VS Marketplace on official VS Code builds and to Open VSX everywhere else, controlled by `intelligit.reviewPrompt.enabled`.
- Added `IntelliGit: Show Review Prompt Card`, which renders the rating card directly in the commit graph with no usage gating and no notification fallback, and says so plainly when no graph view is open to host it.
- Added `IntelliGit: Reset Review Prompt State`, which clears the recorded rating decision and the usage counters behind it on the current machine after a modal confirmation, either back to a fresh install or armed so the next successful commit asks. It never changes a rating already published to a marketplace.

### Fixed

- Fixed the repository lock treating an unrecognized process-liveness errno as proof that the owning window had exited, which could let a second window take over a lock that was still held.
- Fixed the shelf health banner and the shelf tab's warning count falling back to the editor background for their text colour, which rendered them as near-invisible light text on the pale warning band used by light themes.
- Fixed the sidebar Graph view offering to host the rating card it cannot render, which swallowed the request instead of letting the notification take over.
- Fixed the Git success hook reading the subcommand from the first argument, so every commit made with files selected in the Changes panel — which prepends a global option — went uncounted, and the usage gating behind the rating prompt could never advance.

### Changed

- The rating prompt now appears as a centered card in the commit graph rather than as a notification, with a five-star control that opens the marketplace review page on the star click itself for a high rating and asks a low one whether to send feedback instead — the marketplace link stays available either way. The notification is still used whenever no graph view is on screen, and the gating, the three-ask cap and the never-ask-again guarantee are unchanged.

## [0.23.0] - 2026-08-02

### Added

- Added PyCharm-style `Interactively Rebase from Here...` on commit graph entries, opening a dialog that lists the offered range oldest-first with per-commit pick, reword, squash, fixup, and drop actions, button and drag-and-drop reordering, reword and squash message prefill, a warning when the range contains pushed commits, and blocked submission while any reword or squash message is blank.
- Added a standalone interactive-rebase editor helper shipped as `dist/interactive-rebase-editor-helper.cjs`, which Git executes as `GIT_SEQUENCE_EDITOR` and `GIT_EDITOR` to install the generated todo and inject prepared messages, consuming each message exactly once and refusing with a machine-readable reason whenever the live rebase state does not match the submitting session.
- Added persisted rebase sessions reconciled against the repository on reload, classified as owned, discardable, or ambiguous with an explicit reason, defaulting to ambiguous whenever a Git probe fails, and leaving a rebase started outside IntelliGit visible but undriven.
- Added a post-rebase force-push offer for branches whose pushed commits were rewritten, retained across reloads while the rewritten head is still current, and dismissible from the notification.

### Changed

- Aligned the docked and undocked commit panels on one shared operation snapshot, so both surfaces derive their rebase controls and operation fence from the same host-side state instead of duplicating the derivation.

### Fixed

- Fixed abort dispatch running the wrong Git command after a completed rebase left `REBASE_HEAD` behind. Abort now dispatches on a single classification of the active operation rather than probing markers independently, so aborting a genuine merge conflict no longer fails with `fatal: no rebase in progress` and leaves the merge unresolved.
- Fixed 73 host-side messages that were shipping in English for every locale. They were wrapped for translation but never added to the English catalog the translation pipeline reads, so no locale ever received them; they are now catalogued and translated into all 11 supported locales.

## [0.22.0] - 2026-07-30

### Added

- Added GitHub Copilot commit-message generation to the docked and undocked Commit panels, with localized sparkle and stop controls, live streaming, cancellation, and support for normal, amend, and first-commit workflows.
- Added repository-aware prompt context from checked-file diffs, recent commit subjects, and `github.copilot.chat.commitMessageGeneration.instructions`, including bounded text and file instructions.

### Changed

- Limited Copilot input to host-validated checked paths and bounded diff acquisition, with support for tracked, untracked, deleted, renamed, symlink, special-character, SHA-1, and SHA-256 repository changes.
- Coordinated generation per repository across docked and undocked panels, preserving drafts after cancellation or errors and preventing generation from interleaving with commits and whole-index Git operations.

### Fixed

- Ensured Commit panel commits include exactly the checked changes while preserving staged-but-unchecked content, checked renames, literal paths, zero-path amend behavior, and whole-index operation semantics.
- Rejected unexpected non-zero Git exits even when stderr is empty, preventing failed Git operations from being reported as successful.

## [0.21.2] - 2026-07-28

### Changed

- Made the undocked repository/worktree selector a persisted, keyboard-accessible resizable column, and moved Dock into the existing Commit toolbar.

### Fixed

- Removed the redundant undocked IntelliGit header row and restored the worktree header icon and color.

## [0.21.1] - 2026-07-26

### Fixed

- Aligned multi-repository Commit, Stash, and Shelf sections with the repository chevron and matching inner tree guides.
- Unified expanded repository headers, tab strips, and toolbars with their content-panel background.

## [0.21.0] - 2026-07-26

### Changed

- Consolidated duplicated webview UI internals into shared components: one file-tree renderer (rows, folders, indent guides, tri-state checkboxes, drag wiring, keyboard handling) plus shared section headers, checkboxes, and toolbar icon buttons now serve the Commit, Stash, Shelf, and Commit Details panels. Rendered UI is unchanged and was verified byte-for-byte; commit-panel folder rows may carry different auto-generated style class names with identical computed styles.

## [0.20.0] - 2026-07-24

### Added

- Added separate patch-based Shelve workflows in the Commit panel and Command Palette, including flattened and exact-state restore modes, patch import/export, and recovery-aware shelf storage.
- Documented Shelve parity QA and security boundaries, including plaintext local storage, labeled IntelliGit extensions, and lossy flattened `.patch` exports.

## [0.19.1] - 2026-07-23

### Fixed

- Added optional `intelligit.clearLastCommit` setting (default `true`) to clear commit-message drafts after successful local commits; set it to `false` to retain drafts, including when a following push fails.

## [0.19.0] - 2026-07-21

### Added

- Added a PyCharm-style stash body with flat stash selection, a lower changed-file pane, keyboard navigation, and accessible resize and focus behavior.
- Added complete stash actions for apply, pop, advanced unstash options, branch restore, drop, clear, and whole-stash diff sessions.

### Fixed

- Included untracked files in stash listings and diffs while preserving absent before and after sides.
- Prevented duplicate stash mutations until the matching repository-scoped operation completes.
- Aligned stash file rows with Commit pane geometry, labeled stashed and local diff sides explicitly, and corrected branch and changed-file tree guides.

## [0.18.4] - 2026-07-20

### Added

- Added the three-pane merge editor screenshot as the first README feature gallery entry.

### Changed

- Updated README product positioning around IntelliGit's JetBrains-style three-pane merge workflow and unified Git workbench.

## [0.18.3] - 2026-07-14

### Changed

- Show progress notifications while deleting, locking, and moving worktrees.

## [0.18.2] - 2026-07-14

### Changed

- Added a versioned pre-push complexity gate backed by the shared ESLint configuration.
- Refactored working-tree parsing, word-diff alignment, webview setup, and icon-theme helpers as the first 20-point complexity-ratchet phase.

## [0.18.1] - 2026-07-13

### Added

- Added soft, mixed, hard, merge, and keep branch reset actions with localized labels and focused coverage.

### Fixed

- Prevented branch rename and deletion actions from targeting branches checked out in another worktree, including bulk deletion preflight.
- Replaced the untracked Python pre-commit pre-push wrapper with a versioned hook path so linked worktrees do not risk index corruption.

## [0.18.0] - 2026-07-13

### Changed

- Aligned merge-editor conflict colors, empty-middle lines, one-sided hunks, gutter measurement, and connector ribbons with PyCharm presentation.
- Added one-sided hunk coverage to the merge-editor preview fixture.

## [0.17.3] - 2026-07-11

### Fixed

- Show the worktree marker only beside the active worktree, remove it from branch rows, and omit the context menu for the active worktree.

## [0.17.2] - 2026-07-11

### Fixed

- Applied bounded, host-scoped commit-check request gates to GitLab, Bitbucket Cloud, and Bitbucket Server / Data Center, honoring provider rate-limit signals without assuming a server quota.
- Safely reset provider request gates after credential changes and ignored stale pre-refresh rate-limit responses so an old token cannot delay requests for a newly authenticated session.

## [0.17.1] - 2026-07-09

### Fixed

- Limited GitHub commit-check loading to exact visible graph rows with bounded pending and current-HEAD retries, preventing idle multi-repository workspaces from exhausting the shared REST quota.
- Cached no-check results across reloads and stopped background requests before GitHub's remaining quota reaches zero.
- Restored last-known multi-repository changed-file counts immediately on startup while fresh Git status scans reconcile the result.

## [0.17.0] - 2026-07-09

### Added

- Shared commit-check caching and in-flight request deduplication across graph, sidebar, and undocked views.
- Persisted terminal commit-check snapshots across window reloads with bounded age and LRU eviction.
- Batched visible commit-check requests from graph webviews to reduce host message bursts.

### Fixed

- Routed GitHub commit-check requests through a shared concurrency and cooldown gate to avoid duplicate rate-limit bursts across views.

## [0.16.1] - 2026-07-09

### Fixed

- Honored GitHub API rate-limit reset headers for commit-check requests, preventing repeated GitHub calls while the account is cooling down.
- Reused in-flight commit-check fetches for the same commit hash to avoid duplicate API calls during webview refresh bursts.

## [0.16.0] - 2026-07-08

### Added

- Added multi-repository workspace support with per-repository commit accordions and an undocked repository selector.

### Changed

- Scoped IntelliGit graph views to the active repository selected from the active editor or undocked repository list.

## [0.15.4] - 2026-07-07

### Changed

- Removed external JetBrains merge-tool configuration and command wiring from the active conflict-resolution flow.
- Updated merge-conflict file actions so the conflict tree offers IntelliGit's merge editor and VS Code's native merge editor as the two resolution paths.
- Pruned stale JetBrains merge-tool localization entries from generated catalogs during localization import.

## [0.15.3] - 2026-07-06

### Fixed

- Kept commit-panel file counts in sync with external file changes by adding repository file watching and a 5-second fallback refresh cadence matching VS Code Git's status throttle.
- Prevented light refreshes from being lost when they arrive during a full-refresh suppression window.
- Updated working-tree files and counts even when stash, branch, or icon metadata refreshes fail.
- Opened stash file diffs as read-only virtual documents instead of editable untitled buffers.

## [0.15.2] - 2026-07-05

### Changed

- Reworked the merge editor so each pane (ours, result, theirs) flows at its natural height instead of padding every hunk to the tallest pane, keeping a shorter change's next line directly beneath it while segment boundaries stay aligned across panes, PyCharm-style.
- Added SVG connector ribbons that link each conflict hunk across the three panes and track the scroll position.

### Fixed

- Aligned conflict connector ribbons with their colored bands by drawing hunk boundary rules as a zero-height inset shadow, so panes stay pixel-aligned as the file is scrolled.
- Removed a per-conflict scroll jitter that occurred when a hunk first scrolled into view under content-visibility virtualization.
- Sized the merge editor scrollbar correctly on the first paint instead of briefly rendering it one viewport too long.

## [0.15.1] - 2026-07-05

### Changed

- Renamed all user-facing "shelve"/"shelf" terminology to "stash" across the commit panel, menus, and messages to match Git's own vocabulary and remove confusion with PyCharm's separate shelve feature.
- Updated localized strings for the stash terminology across all 11 locales (de, es, fr, ja, ko, pl, pt-br, pt-pt, ru, zh-cn, zh-tw).

### Fixed

- Corrected the Squash Commits error message to instruct users to commit, stash, or rollback local changes.

### Notes

- The public command ID `intelligit.fileShelve` is intentionally unchanged so existing user keybindings keep working; only its display title was updated to "Stash Changes".

## [0.15.0] - 2026-07-05

### Added

- Added a commit-panel Abort Merge action that is visible only while unresolved merge-conflict files are present.
- Added a local merge-editor preview command for visual validation of merge editor changes.

### Changed

- Reworked the merge editor diff pipeline to group conflicts more like PyCharm/IntelliJ, using base-anchored line comparison, weighted important-line matching, gap re-diffing, and chunk-boundary cleanup.
- Updated the merge editor to render PyCharm-style contiguous hunks, synchronized horizontal scrolling, and simplified in-hunk controls.
- Tuned merge editor conflict and word-highlight colors to the requested PyCharm-style palette.

### Fixed

- Colored only the changed rows inside merge conflicts instead of expanding the color zone across filler lines used to align panes.
- Kept merge editor conflict backgrounds and word highlights spanning horizontally scrolled content.
- Refreshed the commit panel, commit graph, and conflict views after aborting a merge from the commit panel.

## [0.14.11] - 2026-07-02

### Added

- Added commit-panel view options for grouping files by directory and showing ignored files on demand.

### Changed

- Render ignored files as read-only commit-panel entries without selection checkboxes.
- Limit ignored-file context menus to Delete and Refresh, and remove the old Show History file action pending a rebuilt history workflow.

### Fixed

- Prevented the Show Ignored Files view option from hanging on large ignored directories by listing ignored directories instead of every ignored file.

## [0.14.10] - 2026-07-01

### Fixed

- Stopped automatic GitHub commit-check fetches from opening the VS Code GitHub sign-in prompt; IntelliGit now uses an existing GitHub session silently and refreshes commit-check badges when the GitHub session changes.

## [0.14.9] - 2026-06-30

### Changed

- Documented the Undock workflow in the README feature gallery.

### Fixed

- Defaulted new remote publication from local `master` to remote `main`.

## [0.14.8] - 2026-06-30

### Changed

- Moved the branch `Create Worktree` context-menu action to the bottom of the branch menu.
- Reused the commit-panel pull and push glyphs for branch update and push menu actions.

## [0.14.7] - 2026-06-30

### Changed

- Expanded the README with a screenshot-led feature gallery covering the commit panel, shelf workflow, commit graph, branch and commit actions, CI checks, unified workbench, and publish flow.
- Reduced the tall commit-panel and shelf screenshots so the README gallery scans better without overwhelming surrounding feature copy.

## [0.14.6] - 2026-06-29

### Added

- Added Bitbucket Cloud and Bitbucket Server / Data Center choices to the first-publish repository creation flow, so new remotes can be created from the same publish path as GitHub and GitLab.

### Changed

- Matched the graph toolbar fetch, pull, push, and sync icons to the commit-panel Git action icon set, including the colored icon-theme variants.

### Fixed

- Allowed push and publish actions to run when the working tree has uncommitted changes, while keeping the dirty-tree warning for pull and sync operations that can merge remote changes into local work.
- Kept Git warning and error notifications manually dismissible instead of auto-closing the dirty-tree warning after a timeout.
- Preserved the selected commit and Changed Files detail pane across graph refreshes when the selected commit is still present in the refreshed list.
- Hardened branch ordering by validating remote default-branch symrefs while preserving default-branch pinning and current `codex/...` branch ordering.
- Used the computed branch name as the publish prompt default while keeping the branch-name prompt at the end of the repository creation flow.
- Kept the push button disabled only for actual non-pushable states, not simply because the working tree is dirty.

## [0.14.5] - 2026-06-27

### Fixed

- Pinned default local and remote branches at the top of the branch tree while keeping current `codex/...` branches first inside their folder and sorting the rest by latest branch-tip date.
- Blocked push, pull, sync, and publish actions when the working tree has uncommitted changes, with the IDE-style warning while leaving fetch available.
- Moved the published branch-name prompt to the end of the create-repository prompt flow and right-aligned the commit-panel Git operation buttons.

## [0.14.4] - 2026-06-27

### Changed

- Cleared the Performance tier of read-only react-doctor warnings by documenting deliberate sequential async flows, small parser/theme transforms, cached `Intl.PluralRules` allocation, and commit-graph lane lookups with narrow inline suppressions.
- Hoisted the `BranchColumn` default `worktrees` array to a stable module constant and simplified commit-ref parsing with a single pass, preserving existing webview behavior while removing the remaining performance diagnostics.

## [0.14.3] - 2026-06-27

### Changed

- Cleared the Maintainability tier of read-only react-doctor warnings by hoisting pure helpers, moving merge-editor line-number helpers and shared icon style constants out of component modules, replacing the remaining host-side barrel import with a direct import, and documenting deliberate false positives with narrow inline suppressions.

### Fixed

- Documented the commit-check visibility polling and commit-graph message subscription as intentional effect patterns so react-doctor no longer reports Bugs-tier false positives while preserving the existing dependency arrays and webview message behavior.

## [0.14.2] - 2026-06-27

### Fixed

- Cleared the Accessibility tier of read-only react-doctor warnings in the webviews by making commit graph and undocked splitters keyboard-resizable, adding keyboard activation for commit rows and merge conflict hunks, and replacing context-menu separator markup with a native `<hr>`.
- Documented deliberate scanner false positives for merge-result autofocus, context-menu overlay stacking, and commit refresh feedback with narrow inline suppressions.

### Changed

- Added localized accessible names for resize controls and merge hunks, then regenerated the webview localization catalogs from the localization CSV.

## [0.14.1] - 2026-06-27

### Changed

- Reduced React static-analysis (react-doctor) warning noise across the webviews through a series of zero-behaviour-change refactors. Split six oversized components into focused presentational children and custom hooks: `CommitList` into `CommitListRows`; `FileTree` into `FileTreeEntries` plus the `useFileDrag` drag-and-drop hook; `CommitGraphPanel` into the `useCommitGraphMessages` message-handler hook; `BranchColumn` into `BranchColumnSections`; `ShelfTab` into `ShelfToolbar` and `ShelfStashList`; and the undocked `App` into `UndockedLayout` plus the `useUnifiedMessages` and `useUndockedActions` hooks. No component render output or webview message contract changed; dependency arrays were preserved verbatim during every extraction.
- Migrated `BranchColumn` and `NativeCommitGraph` to the `useReducer` pattern, pruned derived state in `FileTree` and the checked-files hook with `useMemo`, replaced inline style objects with stable constant references, and switched barrel imports to direct module paths to cut needless re-renders and import-cycle warnings.

### Fixed

- Fixed unstable React list keys and sequential-`await` race conditions in the commit-graph view-provider request handling that react-doctor flagged, reducing bug-class warnings from 33 to 5.
- Parallelised the bulk-branch-delete merge-safety preflight (the per-branch `merge-base --is-ancestor` check) and other independent refresh operations with `Promise.all`; the per-branch checks are independent, so deleting many branches no longer serialises them.

### Security

- Replaced `glpat-`-shaped fixture tokens in the GitLab provider tests with scanner-safe sentinel values so secret scanners stop flagging the test data as a leaked credential (test-only; no runtime change).

## [0.14.0] - 2026-06-25

### Added

- Added a GitLab commit-checks provider that reads the GitLab commit-statuses API (`gitlab.com` and self-hosted hosts via the host map), authenticating with the per-host token from SecretStorage and mapping pipeline statuses into the shared check snapshot. Tokens are passed only to the request header and are never written to logs, error messages, or snapshots.
- Added `Sign In to Commit Checks Provider` and `Sign Out of Commit Checks Provider` commands that securely store and clear per-host access tokens in VS Code SecretStorage, laying the groundwork for self-hosted commit-check providers.
- Added a `CredentialStore` that keys tokens by host with case-insensitive (lowercase) normalization so the same host resolves regardless of capitalization.
- Added the `intelligit.commitChecks.hosts` setting that maps self-hosted Git hostnames to a commit-check provider (`gitlab` or `bitbucket-server`), so self-hosted GitLab and Bitbucket Data Center remotes show CI status badges. The map is normalized and passed to both the docked and undocked commit-graph coordinators.
- Added a Bitbucket Cloud commit-checks provider that reads the `bitbucket.org` commit build-statuses API (following pagination up to a bounded page cap), authenticating with the per-host token from SecretStorage as an `Authorization: Bearer` access token. Every returned build status is aggregated (no CI/CD name allowlist, which could otherwise hide a failing Jenkins or SonarCloud run), Bitbucket states map into the shared check snapshot, and the token is passed only to the request header — never written to logs, error messages, or snapshots.
- Added a Bitbucket Server / Data Center commit-checks provider for self-hosted Bitbucket. It has no built-in host and only serves remotes whose host is mapped to `bitbucket-server` in `intelligit.commitChecks.hosts`; it reads the global `/rest/build-status/1.0/commits/<sha>` endpoint (keyed by commit SHA, following the Server `isLastPage`/`nextPageStart` offset pagination up to a bounded page cap so a failing build on a later page is never dropped) with an `Authorization: Bearer` HTTP access token, rejects plaintext `http://` remotes (SSRF guard), aggregates every build status without a name allowlist, and never writes the token to logs, error messages, or snapshots. The shared Bitbucket row-to-item and state mapping is extracted into one module so Cloud and Data Center cannot drift.
- Added `intelligit.commitChecks.enabled` (turn the whole badge feature off), `intelligit.commitChecks.providers` (per-provider `github`/`gitlab`/`bitbucket-cloud`/`bitbucket-server` toggles), and `intelligit.commitChecks.ciCdFilter` (override which check names count as CI/CD) settings. All are read once at activation and take effect after a window reload; an invalid or unsafe `ciCdFilter` regex falls back to the built-in pattern and shows a one-time warning. A disabled provider yields no badge for its remote and does not fall through to a secondary remote's enabled provider, and a disabled feature renders no badge button at all (no network calls).
- Added a host-targeted `Sign in` button inside the commit-checks badge popover. When a check is `unavailable` only because a token is missing or was rejected (401/403) for a known host, the popover offers a sign-in action that prompts for that exact host's token without re-asking which host — after sign-in the badge re-fetches without a window reload.

### Changed

- Refactored commit checks into a provider seam (`CommitChecksProvider`) and a `CommitChecksCoordinator` that resolves the matching provider per request and caches snapshots by commit hash, re-fetching pending and no-result states until they settle. GitHub, GitLab, Bitbucket Cloud, and Bitbucket Server / Data Center are all active providers behind the seam.
- Made the commit-checks "unavailable" summary provider-agnostic (`Checks unavailable` instead of `GitHub checks unavailable`) so the badge reads correctly for non-GitHub remotes.
- Renamed the badge popover title from `GitHub Commit Checks` to `Commit Checks` now that GitLab, Bitbucket Cloud, and Bitbucket Server are all supported.
- Bounded commit-check re-fetching with a coordinator TTL (15s): `pending`, `none`, and recoverable `unavailable` snapshots are served from cache within the TTL so scrolling and re-renders no longer re-hit a host on every poll, while the 15s graph poll still re-fetches once the TTL elapses. This is a throttle ("at most one request per TTL"), not server-`Retry-After` handling — a transient HTTP 429 auto-recovers after the TTL rather than wedging the badge. Terminal `success`/`failure` snapshots are still cached indefinitely.

### Fixed

- Changed the GitLab provider to return an `unavailable` snapshot with a sign-in hint (instead of a hidden `none`) when no token is stored for the host, so the badge invites authentication rather than disappearing. Sign-in and sign-out now clear the commit-check cache and refresh the graphs (via the new `intelligit.commitChecks.refreshBadges` command) so the badge recovers without a window reload.
- Required the `https:` scheme when parsing the HTTPS form of a GitLab remote URL, so a plaintext `http://` remote can never be queried (SSRF guard).
- Made the webview re-request a recoverable `unavailable` badge (token-missing or a transient host error) on the next graph poll instead of treating it as terminal, so the coordinator TTL recovery and a fresh sign-in are actually reflected without a manual refresh.

### Tests

- Added unit coverage for the GitLab provider (remote-URL parsing including non-`https` scheme rejection, request construction, status mapping, aggregate state, missing-token `unavailable` behavior, and token non-leakage across error paths), the credential store (host normalization, case-insensitivity, missing-host validation), the host-map config normalizer, the auth commands (sign-in/out flows, host validation, storage-failure handling), and the coordinator/provider seam; added view-provider integration tests that route a configured self-hosted GitLab remote through the real coordinator end-to-end.
- Added unit coverage for the Bitbucket Cloud provider (remote-URL parsing including non-`https` scheme rejection and the single fixed host, request construction against the `api.bitbucket.org` host, `Authorization: Bearer` header carrying the stored token verbatim even when it contains a colon, pagination including the page cap, the full Bitbucket state-mapping table, aggregate state, the no-allowlist guarantee that a failing non-keyword tool such as Jenkins still reports `failure`, empty/malformed-response handling, missing-token `unavailable` behavior, and token redaction when a transport error echoes the token verbatim).
- Added unit coverage for the Bitbucket Server / Data Center provider (remote-URL parsing across `https`, `ssh://`, and SCP forms with `http://` rejection, `/scm/` prefix stripping, and host normalization; host-map-gated `match` so the same remote only routes when its host maps to `bitbucket-server`; request construction against the global `https://<host>/rest/build-status/1.0/commits/<sha>` endpoint with the `Authorization: Bearer` token carried verbatim; offset pagination across multiple pages including the page cap and the single-page short-circuit; state mapping, aggregate state, the no-allowlist guarantee, empty/malformed-response handling, missing-token `unavailable` behavior, a network-timeout path, and token non-leakage including redaction); added coordinator tests that a `bitbucket-server`-mapped host selects this provider while an unmapped host does not, and a manifest test asserting the `intelligit.commitChecks.hosts` setting enum offers every host-configurable provider id (`gitlab`, `bitbucket-server`) while excluding the fixed-host SaaS ones.
- Added unit coverage for the settings normalizer (defaults from undefined/garbage input, unknown provider keys ignored, non-boolean coercion, a valid `ciCdFilter` compiling and an invalid one falling back without throwing while flagging `ciCdFilterInvalid`); coordinator tests with a fake clock for the TTL behavior (cache-served `pending`/`unavailable` within the TTL, re-fetch after it, terminal states cached indefinitely), the feature-disabled gate (no provider calls), and the per-provider hard-stop (a disabled origin provider yields `none` without consulting an enabled upstream remote); `shouldRequestCommitChecks` returning true for the recoverable `unavailable` state; `isCiCdCheckItem` honoring a custom include pattern while always keeping the review-bot exclusion; provider tests that `signInHost` is set only on token-missing/401/403 paths (including a self-hosted host) and unset for generic network errors; the host-aware `signIn` command skipping the host picker when given a host; manifest tests for the three new settings; and webview tests that the popover renders the `Sign in` button only for an `unavailable` snapshot carrying a `signInHost`.

## [0.13.9] - 2026-06-25

### Fixed

- Disabled the Commit action until a non-amend commit has both selected files and a non-empty commit message.
- Increased the default Commit input area height and kept Commit before Push/Publish in the action row.

### Tests

- Added webview regression coverage for whitespace-only commit messages and Commit/Push action order.

## [0.13.8] - 2026-06-24

### Fixed

- Routed Commit panel push actions through the shared publish-aware push flow so unpublished branches open publish behavior consistently.
- Allowed Fetch on unpublished branches while keeping unpublished-repository warnings limited to Pull and Sync.
- Added explicit no-remote guidance for branch push and Push All up to Here actions.
- Removed raw codicon placeholders from timed warning notifications.
- Showed local and upstream branch names together in the Commit area branch indicator.

### Tests

- Added and updated regression coverage for publish-aware push routing, unpublished Fetch behavior, no-remote push messages, codicon stripping, and Commit area branch labels.

## [0.13.7] - 2026-06-24

### Fixed

- Pushed tracked branches to their configured upstream target when local and remote branch names differ.
- Stopped showing the publish-branch notification after commit-only panel flows.
- Removed duplicated branch text from the native Commit header and showed the upstream branch leaf in the Commit area branch indicator.

### Tests

- Added and updated regression coverage for mismatched upstream Push, commit-only publish suppression, Commit header branch display, and Commit area upstream branch rendering.

## [0.13.6] - 2026-06-24

### Added

- Added publish-aware Push behavior that opens the publish branch flow when the current branch has no upstream, with the existing remote branch picker prefilled as `origin/<branch>`.
- Added Commit panel branch context by showing the upstream branch in the native Commit header and the local branch in the Commit area.

### Fixed

- Kept unpublished repository warnings on Fetch, Pull, and Sync while routing Push through publish-and-push behavior.
- Removed the raw `$(warning)` codicon placeholder from the unpublished repository warning text.

### Tests

- Added and updated regression coverage for publish branch defaults, Commit panel Git actions, Commit header branch display, and Commit area branch context.

## [0.13.5] - 2026-06-23

### Added

- Added the `intelligit.undockableWindowButtonVisability` setting, defaulting to `true`, to let users hide the IntelliGit undock button from the graph view title.

### Tests

- Added manifest regression coverage for the undock button visibility setting and view-title condition.

## [0.13.4] - 2026-06-23

### Changed

- Moved Fetch, Pull, Push, and Sync beside the Commit and Stash tabs while keeping the same actions available in the graph header.
- Matched the graph-header Git action icons with the toolbar icon style and increased spacing between the tab-row Git actions.
- Updated the Stash Apply and Pop buttons to use the same primary button style as Commit and Push.
- Refreshed README copy to position IntelliGit as bringing together the best Git features from PyCharm, VS Code, and Visual Studio IDE.

### Tests

- Updated webview integration coverage for the Commit panel tab-row Git actions and outbound messages.

## [0.13.3] - 2026-06-23

### Added

- Added right-aligned Fetch, Pull, Push, and Sync actions to the Commit panel file toolbar while keeping the graph header actions available.

### Tests

- Added webview regression coverage for the Commit panel Git action buttons and outbound messages.

## [0.13.2] - 2026-06-23

### Changed

- Moved Fetch, Pull, Push, and Sync from the Commit toolbar into the graph sidebar branch header so repository transport actions live with branch navigation.

### Fixed

- Wired graph/sidebar and undocked Git action handling through the existing Git operation flow so the moved actions run and refresh consistently across graph surfaces.
- Sent current upstream, ahead/behind, and remote state with graph branch snapshots so sidebar Git action enablement stays accurate.

### Tests

- Updated webview regression coverage for sidebar Git action placement and enablement.

## [0.13.1] - 2026-06-23

### Added

- Added Fetch, Pull, Push, and Sync actions to the Commit view toolbar, with Push enabled only when the current branch has commits ahead of its upstream.

### Changed

- Replaced the Commit and Push button in the Commit area with toolbar Git operations and made the Commit button reflect staged-change readiness.
- Changed non-error information and warning notifications to auto-dismiss after five seconds while keeping error messages permanent.

### Fixed

- Fixed Commit view Collapse All so it also collapses the top-level Changes and Unversioned Files sections.

## [0.13.0] - 2026-06-21

### Added

- Added Phase 0 Git worktree support with typed worktree metadata, a `git worktree list --porcelain -z` parser, and focused parser/integration coverage.
- Added Phase 1 read-only Worktrees view in the IntelliGit sidebar with cached worktree refreshes, localized view title, and native tree-provider coverage.
- Added Phase 2 branch worktree badges, Open Worktree branch action, and checkout guards that open an existing worktree instead of running a failing checkout.
- Added Phase 3 worktree creation from branch actions with path safety checks, remote-branch upstream tracking, and a Worktrees view title command.
- Added Phase 4 safe worktree deletion from the Worktrees view with main/current guards, dirty-worktree confirmation, and no branch deletion side effects.
- Added Phase 5 worktree include-file seeding so configured gitignored files such as `.env` or `.vscode/settings.json` can be copied into newly created worktrees.
- Added Phase 6 advanced worktree operations for lock, unlock, move, prune, and repair with refreshed Worktrees view state.

### Changed

- Moved the Worktrees list into the branch column below Remote branches while preserving sidebar worktree actions for open, delete, lock/unlock, and move from the new context menu.

### Tests

- Added branch-column regression coverage for worktree ordering, row opening, and locked/unlocked worktree context-menu action parity.

## [0.12.1] - 2026-06-21

### Fixed

- Refreshed pending GitHub commit checks for visible commits so rows no longer keep spinning after GitHub Actions completes.

### Tests

- Added regression coverage for pending-check retry behavior in the commit list and provider cache refresh path.

## [0.12.0] - 2026-06-21

### Added

- Added GitHub commit checks to commit graph rows, fetching Checks API runs and legacy commit statuses for visible commits and showing the result in a JetBrains-style popover.

### Changed

- Limited the commit checks popover to CI/CD-style signals such as build, release, guard, security, test, lint, deploy, and workflow checks, excluding review-bot rows such as CodeRabbit and code review statuses.
- Matched commit-check and context-menu popover surfaces to the IntelliGit panel background and centralized commit-check status icons through `react-icons`.

### Fixed

- Kept commit-check popovers inside the viewport so the header remains visible when opened near panel edges.
- Hid the commit-check indicator when GitHub returns no CI/CD checks for a commit.

### Tests

- Added service and webview regression coverage for GitHub check normalization, CI/CD filtering, click-open/outside-close behavior, viewport clamping, empty-check hiding, and visible-commit check requests.

## [0.11.4] - 2026-06-21

### Changed

- Updated the README header to use linked flag-language entries, the IntelliGit logo, tagline, badge row, and an auto-populated version badge sourced from `package.json`.

## [0.11.3] - 2026-06-20

### Changed

- Refreshed the README with clearer IntelliGit product positioning, grounded workflow copy, supported-language visibility, the project logo, marketplace links, setup guidance, and developer documentation links.

## [0.11.2] - 2026-06-18

### Fixed

- Fixed the extension entering no-repository mode when the workspace folder opened in the IDE is a subdirectory of the git root (e.g. opening `/root/client/project2` when `.git` lives at `/root/client`). Commits were blocked in this configuration even though IntelliJ IDE handled it correctly.

### CI

- Added a `workflow_dispatch` trigger to the publish workflow so a deploy silently skipped by GitHub can be re-triggered manually without a version bump (requires repo write access; a `force_publish` input bypasses only the version-change gate while the double-publish guard remains active).
- Added a `guard-no-skip-ci` required status check that scans every PR commit message, PR title, and PR body for CI-skip directives and blocks the merge, preventing a squash merge from carrying a skip token into main and suppressing the push-to-main deploy.

## [0.11.1] - 2026-06-18

### Added

- Added a native three-way merge editor that resolves conflicts directly inside VS Code without requiring an external JetBrains IDE, rendering base, ours, theirs, and an editable result pane in a single host panel.
- Added an editable result pane with IntelliJ-style manual merge editing: accept either side or both, drop a hunk, or type directly into the merged output, with Apply gated until every true conflict is resolved.
- Added token-level auto-resolution that composes non-overlapping intra-line edits from both sides, marking cleanly merged hunks as auto-resolved instead of requiring a manual decision while keeping them overridable.
- Added intra-hunk row alignment that injects spacer rows so equal indexes line up across the three panes, keeping the base, ours, and theirs views height-synchronized.
- Added keyboard-driven conflict resolution, an auto-resolved conflict count, and an overview gutter with per-conflict markers and navigation.
- Added lightweight, theme-colored syntax highlighting for merge code blocks via a single-line tokenizer that classifies comments, strings, keywords, constants, and numbers using VS Code theme variables.
- Added scroll synchronization, memoized render paths, and content-visibility virtualization so large conflicted files stay responsive.

### Changed

- Separated commit-panel drag selection from commit checkboxes and corrected Chromium drag-data handling so range selection no longer toggles staging.
- Reduced branch list and commit graph row spacing for tighter IntelliJ-style density.
- Reorganized the test suite into a domain-categorized directory hierarchy.

### Fixed

- Completed branch delete behavior and reset the cached current-branch upstream flag after branch operations so push-target resolution stays correct.
- Removed a hardcoded filename color so selected and unselected file rows follow theme foreground colors.

### Localized

- Synchronized merge editor strings, including conflict status and the auto-resolved label, across all 12 supported locales and the localization CSV.

### Tests

- Added spec-derived coverage for the syntax tokenizer, token-level auto-merge, and the row-alignment flow with spacer rows and line-number skips, and raised the coverage ratchet in the same change.

## [0.10.0] - 2026-06-07

### Added

- Added bulk branch deletion from branch graph, repository tree, and undocked views with guarded current-branch rejection, merged-branch preflight checks, partial-failure reporting, and focused command/provider coverage.

### Changed

- Refreshed branch and file-state flows so branch actions, commit-file diff requests, and intent-to-add updates keep graph, panel, and repository views synchronized without unnecessary visible refresh indicators.

### Tests

- Added and updated regression coverage for branch bulk-delete command payloads, provider protocols, branch/file refresh wiring, commit panel intent-to-add silent refresh behavior, and GitOps intent-to-add execution.

## [0.9.6] - 2026-06-06

### Added

- Added the TSDoc rollout baseline audit under `docs/tsdocs` with source counts, exported-symbol estimates, documentation block counts, boundary-heavy areas, plugin status, validation script availability, and confirmed phase order.
- Added the IntelliGit TSDoc standard under `docs/tsdocs`, including the standard block template, tag guidance, examples for the major extension areas, and the rule against type repetition.
- Added `eslint-plugin-jsdoc` and `eslint-plugin-tsdoc` with TSDoc syntax validation for extension TypeScript and React webview TypeScript/TSX files, without enabling global required-documentation enforcement.
- Added scoped TSDoc ratchet scaffolding and pilot locked globs for Git executor, shared domain types, shared React menu contracts, and commit graph canvas hook documentation.
- Documented Git operation contracts across status parsing, log/history loading, branch/remotes, staging, rollback, stash, and conflict helpers, then locked `src/git/**/*.ts` into the TSDoc ratchet.
- Documented webview protocol contracts for commit graph, commit info, commit panel, merge-conflict session, and undocked messages, then locked `src/webviews/protocol/**/*.ts` into the TSDoc ratchet.
- Documented service contracts for clone, publish, diff, askpass, Git helpers, JetBrains merge integration, and repository discovery workflows, then locked `src/services/**/*.ts` into the TSDoc ratchet.
- Documented extension activation lifecycle, repository/no-repository startup modes, command registration wiring, view-event forwarding, and disposable ownership, then locked `src/extension.ts` and `src/activation/**/*.ts` into the TSDoc ratchet.
- Documented command handler contracts for branch, commit context, basic commit actions, and history mutations, then locked `src/commands/**/*.ts` into the TSDoc ratchet.
- Documented view provider contracts for commit graph/info/panel, merge-conflict panels, onboarding, undocked views, refresh behavior, message validation, and webview HTML, then locked `src/views/**/*.ts` into the TSDoc ratchet.
- Documented utility, merge conflict parser, and webview i18n support contracts, then locked `src/utils/**/*.ts`, `src/mergeEditor/**/*.ts`, and `src/webviews/i18n/**/*.ts` into the TSDoc ratchet.
- Documented React shared settings, localization, VS Code API, file-tree, branch-column, and commit-list model contracts, then locked `src/webviews/react/shared/**/*.{ts,tsx}`, `src/webviews/react/branch-column/**/*.{ts,tsx}`, and `src/webviews/react/commit-list/**/*.{ts,tsx}` into the TSDoc ratchet.
- Documented commit panel React commit, shelf, file-tree selection, message bridge, and PyCharm-style UI helper contracts, then locked `src/webviews/react/commit-panel/**/*.{ts,tsx}` into the TSDoc ratchet.
- Documented remaining React app, graph, commit-info, merge-conflict session, merge-editor, and undocked layout contracts, then expanded the React TSDoc ratchet to `src/webviews/react/**/*.{ts,tsx}`.
- Closed the source documentation ratchet by replacing the piecemeal extension globs with full `src/**/*.ts` coverage while keeping the separate React TS/TSX ratchet and its presentational-component guard.
- Added long-term TSDoc governance guidance with contributor/reviewer checklists, good/bad comment examples, and stale-documentation maintenance commands.

### Changed

- Linked the TSDoc standard and rollout baseline from the README development documentation.
- Expanded README development documentation with TSDoc contributor and reviewer expectations.

### Fixed

- Pointed the localization CSV tooling, tests, and workflow documentation at `docs/localization/localization_translation_review.csv` so validation uses the current reviewed-translation source path.
- Updated existing comments that mentioned Git upstream refs, credential-bearing URLs, and placeholder examples so they pass TSDoc syntax validation without changing runtime behavior.

### Verification

- Verified the documentation baseline, TSDoc standard placement, release metadata, documentation syntax linting, scoped ratchet pilot enforcement, Git contract ratchet enforcement, protocol contract ratchet enforcement, service contract ratchet enforcement, activation-flow contract ratchet enforcement, command handler contract ratchet enforcement, view-provider contract ratchet enforcement, utility and merge-editor contract ratchet enforcement, commit panel React contract ratchet enforcement, remaining React app contract ratchet enforcement, closed source documentation ratchet enforcement, long-term documentation governance guidance, localization path correction, and repository validation gates for the TSDoc rollout phases.

## [0.9.5] - 2026-06-06

### Fixed

- Reject whitespace-only merge conflict session file paths before accepting either side, while preserving valid filenames that intentionally include leading or trailing spaces.
- Keep the real-Git pathspec magic regression test portable by skipping the invalid filename scenario on Windows.
- Strengthen repository discovery coverage for workspace Git root resolution.
- Exclude local GitNexus code-intelligence metadata from packaged VSIX artifacts.
- Use the checked-out branch name when updating the selected branch, so stale cached branch metadata still takes the current-branch fetch-then-merge path.

### Security

- Replaced machine-specific security scan paths in documentation with placeholders for the repository root, scan directory, scan id, Codex home, plugin directory, and scan artifact root.

### Verification

- Added regression coverage for whitespace-only conflict session paths being ignored without surfacing an error, and preserved coverage for trailing-space conflict filenames.
- Added regression coverage for stale current-branch metadata using the checked-out branch update path.
- Verified platform-safe pathspec behavior, repository discovery resolver expectations, security-doc path cleanup, full project validation, and release package generation.

## [0.9.4] - 2026-06-04

### Changed

- Replaced fictional 90% coverage thresholds with an enforceable coverage floor and wired CI to run `bun run test:coverage` so coverage gates are actually enforced.
- Promoted type-aware async and unsafe-value lint rules to errors, and restored a meaningful cognitive-complexity gate with explicit grandfathered hotspots.
- Split Git history and working-tree parsing into focused helper modules so `GitOps` can delegate pure parsing/planning logic without changing runtime behavior.

### Fixed

- Hardened Git log branch filtering by validating branch refs and passing branch filters after `--end-of-options`.
- Replaced conflict-marker detection with a linear scan so large non-conflicted files avoid regex backtracking risk.
- Excluded local Repowise metadata from packaged VSIX artifacts.

### Security

- Consolidated clone and publish `GIT_ASKPASS` credential plumbing into one shared helper so future credential-handling fixes cannot drift between flows.

### Verification

- Added regression coverage for branch-argument hardening, conflict-marker detection, JetBrains merge service/tool launch paths, diff service file operations, undocked provider protocols, file icon theme resolution, and merge/conflict webview behavior.
- Verified format, lint, strict lint, architecture, React Doctor, typecheck, build, localization validation, localization audit, CSV validation, tests, coverage, production build, package, and VSIX package-content audit.

## [0.9.3] - 2026-06-04

### Added

- Added an `Open in Current Window` action to the clone success prompt so users can open a cloned repository in the existing VS Code window without adding it to a multi-root workspace.

### Localized

- Added localized clone action labels for `Open in Current Window` across the host localization source catalog, locale bundles, and translation review CSV.

### Verification

- Added clone-flow regression coverage for opening a cloned repository in the current window without calling the workspace-folder API.

## [0.9.2] - 2026-06-04

### Added

- Added React Doctor as a repository validation tool with a `bun run react-doctor` script and a non-interactive, offline configuration that fails on error-level diagnostics.
- Added runtime-scoped ESLint quality gates for the extension host, React webviews, Node scripts, and typed TypeScript sources.
- Added React Hooks linting so Rules of Hooks violations fail lint while exhaustive dependency findings start as warnings.
- Added type-aware TypeScript ESLint recommendations with the initial noisy cleanup staged through targeted warning-level rules.
- Added Knip with both report-only and strict validation paths for unused files, exports, dependencies, and devDependencies.
- Added dependency-cruiser with a strict `bun run architecture:check` script for focused architecture validation.
- Added dependency-cruiser rules for unresolved imports, circular dependencies, extension-host/webview boundaries, domain-layer-to-UI boundaries, and webview imports of Node or VS Code runtime APIs.
- Added SonarJS lint rules for selected high-signal code-smell detection, with cognitive complexity starting as a warning at an intentionally high baseline threshold.

### Changed

- Updated the pre-commit validation checklist to run React Doctor and dependency-cruiser alongside format, lint, architecture, typecheck, build, localization, and tests.
- Split ESLint configuration by runtime so extension-host TypeScript, React webviews, Node scripts, and typed TypeScript sources use the correct globals, parser projects, and plugin sets.
- Wired the existing React ESLint plugin safely into the React webview lint path with flat config support and a pinned React version.
- Moved shared webview message protocol types into `src/webviews/protocol` so extension-host code no longer imports React UI modules.
- Moved the refresh coordinator into the views layer because it directly orchestrates view provider refreshes.
- Kept SonarJS code-smell checks warning-level for CI adoption while ensuring the local strict lint gate is already clean.

### Removed

- Removed unused files, exports, and dependencies identified during Knip cleanup.

### Fixed

- Fixed React Doctor error-level findings for conditional hook usage in the branch tracking badge.
- Fixed React Hooks exhaustive-dependency findings that were safe to address in the initial cleanup pass.
- Fixed type-aware TypeScript ESLint findings around async handling, unsafe values, unnecessary assertions, and promise usage.
- Fixed architecture boundary violations by moving shared protocols and refresh coordination to layers that match their runtime responsibilities.
- Enforced host/webview architecture boundaries while preserving message-based communication between the extension host and React webviews.

### Verification

- Verified React Doctor reports zero error-level diagnostics.
- Verified dependency-cruiser reports no architecture violations.
- Verified strict ESLint, strict Knip, typecheck, build, localization validation, localization audit, localization CSV validation, and the full test suite pass.

## [0.9.1] - 2026-06-04

### Fixed

- Updated the current-branch Update flow to fetch the tracked remote first, then merge the tracked remote ref with PyCharm-style Git arguments instead of failing on divergent histories with a fast-forward-only pull.
- Replaced raw divergent-branch Git output with a concise localized error message that removes fetch boilerplate, Git hints, and fatal/internal details.
- Open the Conflicts session when an Update merge produces unresolved conflict files, so merge conflicts enter the existing resolution workflow instead of surfacing as a generic failure.

### Preserved

- Non-current local branches still update through the existing fetch-refspec flow without checking out or merging those branches.

### Localized

- Added the new divergent-branch Update message to the localization source catalog, locale bundles, and translation review CSV.
- Applied reviewed translations for updated host locale bundles: `de`, `es`, `fr`, `ja`, `ko`, `pl`, `pt-br`, `pt-pt`, `ru`, `zh-cn`, and `zh-tw`.

### Verification

- Added regression coverage for current-branch fetch + merge behavior, concise divergence error messaging, and preserved non-current branch update behavior.
- Verified with format, lint, typecheck, build, localization validation, localization audit, CSV validation, and the full test suite.

## [0.9.0] - 2026-06-02

### Added

- Added full extension localization infrastructure across the VS Code manifest, extension host, and React webviews.
- Added localized catalogs for German, Spanish, French, Japanese, Korean, Polish, Portuguese (Brazil), Portuguese (Portugal), Russian, Simplified Chinese, and Traditional Chinese.
- Added VS Code manifest localization via `package.nls.*.json`, including command titles, view titles, configuration labels, configuration descriptions, and enum labels.
- Added extension-host localization via `l10n/bundle.l10n.*.json` for notifications, prompts, progress messages, quick-pick labels, validation errors, Git operation messages, merge-conflict actions, clone/publish/setup flows, and activity-bar badge tooltips.
- Added webview localization via `src/webviews/i18n/*.json` for the commit panel, commit graph, branch menus, changed-file UI, commit detail panel, merge editor, conflict session, onboarding, toolbar labels, empty states, status labels, and context menus.
- Added a single translation review CSV at `docs/localization/localization_translation_review.csv` as the source of truth for all manifest, host, and webview translations.
- Added CSV import and validation tooling so reviewed translations can be imported back into generated catalogs instead of editing every locale JSON file by hand.
- Added localization tests that verify required locale coverage, catalog synchronization, placeholder preservation, plural-category shape, manifest entries, host bundles, and webview bundles.
- Added a hardcoded-string audit for user-facing source code so new English UI strings are caught when they are not routed through `vscode.l10n.t(...)` or webview `t(...)`.
- Added a Git terminology glossary for translators and reviewers so terms such as Git, commit, branch, stash, rebase, remote, worktree, VS Code, JetBrains, and Squash remain consistent across languages.

### Changed

- Converted extension host strings from raw English literals to `vscode.l10n.t(...)`, including user-visible errors, confirmations, progress titles, branch/commit actions, merge conflict commands, and repository setup messages.
- Converted React webview UI strings to the shared webview `t(...)` helper, including placeholder interpolation and plural-aware messages.
- Replaced hardcoded manifest text with `%key%` references backed by `package.nls.json` and locale-specific `package.nls.*.json` files.
- Made the localization workflow reviewable: translators can update one CSV, validate placeholders and required columns, then regenerate all locale catalogs consistently.
- Preserved placeholder tokens such as `{count}`, `{path}`, `{branch}`, `{short}`, `{remote}`, `{remoteBranch}`, and codicon tokens so translated strings do not break runtime interpolation.
- Preserved product and technical terminology where translating it would reduce clarity, including IntelliGit, Git, VS Code, JetBrains product names, command-line flags, URLs, SSH, HTTPS, and common Git operation names.
- Preserved Git jargon intentionally in places where localized VS Code/Git users expect the English term, such as Squash, Rebase, Checkout, commit, branch, and stash.
- Preserved the PyCharm/JetBrains-style UI behavior while only changing string loading and translated display text.
- Preserved the real-time changed-file count refresh work from `main`, including VS Code Git state listeners, background refresh coalescing, activity-bar badge clearing, and the blue refresh indicator during background checks.
- Increased the minimum visible duration of the commit-panel refresh indicator to 600ms so background file-count checks are visible without changing the refresh logic.
- Preserved the branch-scope cherry-pick guard from `main` while keeping the commit context menu localized.

### Fixed

- Fixed the earlier partial-localization state where only manifest metadata was translated while host runtime strings and webview UI still fell back to English.
- Fixed missing non-English host and webview catalogs by generating and validating every supported locale.
- Fixed translation validation gaps so tests now fail when required locale catalogs or CSV rows are missing.
- Fixed machine-translation artifacts that corrupted placeholders or translated placeholder stand-ins instead of preserving the original tokens.
- Fixed several reviewed translation quality issues found during deep scans, including mistranslated Git terms, untranslated Squash labels, Korean hunk/conflict wording, German checkout/rebase wording, French JetBrains merge-tool wording, and merge-session subtitle spacing around branch names.
- Fixed the new changed-files badge view introduced from `main` so its view title and tooltip are localized instead of adding new raw English strings.
- Fixed webview HTML localization payload escaping so translated JSON embedded in webviews cannot break the generated HTML.
- Fixed duplicate or stale catalog drift by making the CSV validation compare generated catalogs against the review CSV.

### Verification

- Verified localization with `bun run l10n:validate`.
- Verified hardcoded UI string coverage with `bun run l10n:audit`.
- Verified focused localization tests with `bun vitest run tests/unit/localization.test.ts`.
- Verified the merged branch with `bun run typecheck`, `bun run build`, and `bun run test`.

## [0.8.18] - 2026-06-02

### Fixed

- Commit panel changed-file counts now refresh from VS Code Git repository state changes, keeping IntelliGit aligned with native Source Control without requiring the user to focus the IntelliGit view.
- Background changed-file/status refreshes now show the blue refresh indicator in docked and undocked commit panels while IntelliGit checks for updated file counts.

## [0.8.17] - 2026-06-01

### Fixed

- Restored a dedicated hidden changed-files badge carrier view so the IntelliGit activity icon count now clears correctly after commit/refresh cycles without double counting the Commit view.
- Removed the Commit view title-bar Refresh action entirely and made the in-panel Refresh button show an immediate, centered blue spin state while also routing refresh through VS Code's native view progress indicator.
- Graph commit context menus now disable `Cherry-Pick` when viewing the current branch or the all-branches graph, and only enable it for other branch scopes where the action is meaningful.

### Tests

- Added regression coverage for activity-bar changed-file badge clearing and branch-scope cherry-pick enablement.

## [0.8.16] - 2026-05-31

### Fixed

- Undocked window columns now use container-aware reflow via `ResizeObserver` and dynamic normalization so they continue to occupy the full available width after window resizing.
- Removed the hidden badge-only IntelliGit view and moved the changed-file count badge onto the real Commit view, preventing a blank panel from appearing in repository workspaces.

## [0.8.15] - 2026-05-31

### Fixed

- Undocked window sections now start with equal widths, preserve the full available width while resizing adjacent sections, and restore cached user widths across close/reopen.
- Legacy undocked width caches missing the Graph column width are migrated instead of being discarded.
- Re-running "Undock in New Window" while IntelliGit is already undocked now only reveals the existing window instead of moving the currently active editor.

## [0.8.14] - 2026-05-30

### Fixed

- Graph view onboarding now stays blank when no workspace or no Git repository is available, while IntelliGit and Changes keep the clone/open/initialize actions.
- Removed duplicate "Changes" display name on the hidden `intelligit.fileCountBadge` tree view that carries the activity bar badge — it no longer shares a name with the real Changes panel.
- Undocked window sections (Commit, Branches, Graph, Changes) now start with equal widths on first open. Resized widths persist across panel close/reopen via extension workspace state.
- `intelligit.commitWindowPosition` now defaults to `auto`, following VS Code's `workbench.sideBar.location` unless explicitly set to `left` or `right`.
- Commit panel now shows "Publish Branch..." instead of "Commit and Push..." when the current branch has no upstream, avoiding `git push` with no configured destination.
- Commit and Push now checks the configured upstream remote before committing, so deleted or inaccessible remote repositories fail preemptively instead of leaving a new local commit behind.
- Undocked window layout changes from sidebar-position settings now preserve graph selection/filter state and clamp restored pane widths to the visible viewport.

## [0.8.13] - 2026-05-30

### Fixed

- Removed duplicate display name from a hidden tree view element
  Fixed undocked window sections to open with equal starting widths and persist user resizing across close/reopen
  Improvements

- Updated onboarding interface based on workspace state
  Simplified repository initialization confirmation with instant feedback

## [0.8.12] - 2026-05-29

### Added

- Added `intelligit.commitWindowPosition` to place the undocked/tabbed Commit window on the left or right side, defaulting to `left`.

### Fixed

- Commit window Refresh button now spins only for explicit user-triggered refreshes, not for theme changes or background workspace updates.

## [0.8.11] - 2026-05-29

### Fixed

- Stash Panel now adheres to the color theme rather than a hardcoded color

## [0.8.10] - 2026-05-28

### Added

- `intelligit.icons` setting (`"color"` | `"standard"`, default `"color"`): `standard` renders toolbar icons and status-badge letters using VS Code's monochromatic `--vscode-icon-foreground` token, consistent with native VS Code panels; `color` keeps the existing coloured icon style.

### Fixed

- Activity bar badge showed double the correct file count (e.g. 6 instead of 3) because the commit-panel webview badge and the dedicated `intelligit.fileCountBadge` tree view each contributed the same count to the container. Removed the redundant webview badge so only the dedicated tree view drives the activity bar icon number.
- "Changes N files" section header in the commit panel counted a file twice when it had both staged and unstaged modifications. Count is now deduped by path.

## [0.8.9] - 2026-05-28

### Changed

- PyCharm theme CSS variables now delegate to VS Code's native CSS custom properties so they adapt to the active colour theme; each variable keeps a hardcoded fallback for environments where the VS Code variable is unavailable.
- Checkbox unchecked border and checked background now use centralized `--intelligit-pycharm-checkbox-*` variables with `--vscode-checkbox-*` fallbacks.

### Fixed

- Commit tab drag-handle accent switched from `var(--vscode-descriptionForeground)` to `var(--intelligit-pycharm-muted)` for consistent PyCharm theming.

## [0.8.8] - 2026-05-28

### Changed

- Restyled the Commit tool window to more closely match PyCharm's dark Git UI, including tabs, toolbar chrome, section rows, file tree spacing, status colours, and commit controls.
- Kept commit-panel toolbar actions in one compact, evenly spaced group instead of stretching actions across the full panel width.

### Fixed

- Aligned file and folder selection checkboxes in the Changes tree and increased checkbox border weight for a sharper PyCharm-style appearance.

## [0.8.7] - 2026-05-28

### Changed

- Extracted `CommitGraphPanel` into a reusable component shared by the main graph view and the commit panel's embedded graph area.
- Commit panel now renders a compact native-git-style graph below the commit message — graph lanes and commit message only, with an inline tooltip on hover matching the middle panel's tooltip.
- Added `showSearch`, `showAuthorDate`, and `headerLabel` props to `CommitList` for per-panel customization.
- Added `showAuthorDate` prop to `CommitRow` to conditionally hide the Author and Date columns.
- Left panel graph header shows bold "Graph" label; middle panel retains "Commit | Author | Date".
- Duplicate `intelligit.initializeRepository` command consolidated into a shared `initializeRepository()` handler using `GitOps.init()`.
- `fetchGitHubRepos` in clone service hardened with request timeout and pagination cap.
- New event emitters (`onDidChangeFileCount`, `onDidChangeWorkingTree`) and centralized refresh coordination keep docked and undocked UI instances in sync during repository mutations.

### Fixed

- Commit panel graph rendering: reuse the same proven `CommitList` component instead of custom canvas rendering.
- Synchronization of working-tree and commit state between docked Commit Panel and undocked views: docked panel now refreshes the commit graph when the undocked view modifies the working tree.

## [0.8.6] - 2026-05-27

### Added

- Interactive onboarding webview shown when no workspace folder is open or no Git repository exists, replacing the previous static placeholder text.
- "Initialize Repository" action that runs `git init` in the selected workspace folder and offers to reload the window to activate IntelliGit.
- Custom clone flow with three provider options: GitHub (OAuth via VS Code session, browse repos or enter URL), GitLab (PAT via SecretStorage), and SSH.
- "Open Folder" action that delegates to VS Code's built-in `vscode.openFolder` command.
- `GitOps.init()` method for initializing new Git repositories programmatically.
- New commands `intelligit.cloneRepository`, `intelligit.openFolder`, and `intelligit.initializeRepository` registered in the command palette.
- "Publish Branch" flow after first commit: detects unpublished branches, creates remote repositories on GitHub or GitLab, adds the remote, and pushes with `--set-upstream`.
- `intelligit.publishBranch` command for manually triggering the publish flow from the command palette.
- `GitOps` methods for publish support: `hasAnyCommits`, `getRemotes`, `branchHasUpstream`, `addRemote`, `removeRemote`, `pushWithUpstream`.

### Changed

- The empty-state webview providers now use `OnboardingViewProvider` with contextual actions instead of the static `EmptyIntelliGitWebviewProvider`.
- `intelligit.cloneRepository` now runs the custom IntelliGit clone flow instead of delegating to VS Code's built-in `git.clone`.

### Security

- GitLab personal access tokens are stored in VS Code SecretStorage, not in user settings.
- Clone and publish pushes use transient Git askpass credentials so provider tokens are not written into remote URLs or shell arguments.

### Tests

- Add focused activation, onboarding, Git command construction, clone command, and publish-flow coverage for the onboarding and publish workflows.

## [0.8.5] - 2026-05-26

### Changed

- Open commit Changed Files diffs on double-click instead of single-click, matching standard VS Code and PyCharm tree interactions.

### Fixed

- Render commit diff sides from read-only virtual documents so historical file snapshots cannot be edited accidentally and closing the diff does not prompt to save.

### Tests

- Add regression coverage for Changed Files single-click suppression, double-click diff opening, and read-only diff URI usage.

## [0.8.4] - 2026-05-26

### Fixed

- Register IntelliGit undock commands in empty VS Code workspaces so clicking Undock shows a no-repository message instead of a command-not-found error.
- Dispose stale restored undocked editor panels on activation to avoid blank hanging windows after reopening VS Code.
- Open the Changed Files diff editor on single-click from the commit detail file tree, matching the PyCharm interaction.

### Tests

- Add regression coverage for empty-workspace undock commands, stale restored undocked panels, and Changed Files single-click diff opening.

## [0.8.3] - 2026-05-25

### Added

- Undock button in the IntelliGit view title bar, next to "Select Repository", launching a command-palette picker with "Undock in Editor Tab" and "Undock in New Window" options.

### Changed

- Restyle all context menus to match the PyCharm New UI: neutral-dark `#2B2D30` background, solid `#43454A` border, flush items without inner radius, `#2E436E` selection highlight, softer shadow, and corrected hint/shortcut typography and colours.
- Extract undocked-panel creation from data loading so the lifecycle is cleanly split into `ensureUndockedPanel` (fast) and `loadUndockedData` (deferred).

### Fixed

- Eliminate the ~2-second editor-tab flicker when choosing "Undock in New Window" by opening the panel immediately, moving it to a floating VS Code window, and only then loading branch and commit data into the already-opened window.

### Removed

- Undock button and context menu from the commit-panel toolbar; these actions are now accessed exclusively from the title bar.

### Tests

- Update commit-panel integration test to remove assertions for the now-removed toolbar undock button.

## [0.8.2] - 2026-05-25

### Changed

- Restyle the stash panel to more closely match the PyCharm Git tool window, including toolbar actions, selected stash rows, branch labels, and bottom apply/pop controls.

### Added

- Add a PyCharm-style stash context menu with apply, pop, drop, and diff actions.

### Tests

- Update commit panel integration coverage for stash apply, pop, and context-menu drop interactions.

## [0.8.1] - 2026-05-25

### Fixed

- Decouple the undocked editor tab lifecycle from `intelligit.undockableWindow`, so the tab opens only from user action and closing it no longer edits settings or reloads VS Code.

### Tests

- Add regression coverage for undocked activation, manual opening, closing, and reopening without settings mutation or window reload.

## [0.8.0] - 2026-05-25

### Added

- Undockable window mode via `intelligit.undockableWindow` setting: renders the commit graph and commit panel as a single unified editor tab instead of sidebar + bottom panel, enabling native VS Code undocking to a second monitor.
- Horizontal-split layout in undocked mode: branch column, commit list, and commit details on the left; file changes, commit message, and shelf on the right, with resizable dividers between all columns.
- `IntelliGit: Toggle Undocked Window` command to switch between docked and undocked layouts without editing settings.json.

## [0.7.3] - 2026-05-25

### Fixed

- Fix commits failing when the selected file list includes paths that were already staged as deleted, avoiding Git pathspec errors during mixed commit flows.
- Restore selected files more completely during rollback by clearing staged index changes, restoring tracked working-tree changes, and removing selected untracked or newly staged files.
- Restore all changes more reliably by using a hard reset followed by cleanup, so staged edits, unstaged edits, staged additions, and untracked files are all returned to a clean repository state.
- Restore staged renames correctly when rolling back selected files by resetting both the destination and original path, restoring the original file, and cleaning the renamed path.
- Allow repo-relative filenames that look like command options, such as `--weird.txt`, when reading historical file content while still rejecting invalid refs and traversal paths.
- Validate commit-panel selected paths before staging or committing so malformed webview payloads cannot bypass repo-relative path checks.
- Validate file context-menu paths before rollback, shelve, and file-history operations to reject traversal payloads before any Git command is run.
- Validate commit graph and changed-files webview command payloads at runtime, including commit hashes, branch/commit action names, and repo-relative file paths.

### Tests

- Add regression coverage for committing selected deleted files, including unstaged deletions and already staged deletions.
- Add real temporary Git repository coverage for file staging, unstaging, deletion, and rollback state transitions across modified, deleted, untracked, newly added, staged-add-then-deleted, renamed, nested, space-containing, and option-like file paths.
- Add webview payload validation coverage for commit-panel selected paths.
- Add webview payload validation coverage for commit graph and changed-files command messages.
- Add extension command validation coverage for file rollback, shelve, and file-history context actions.

## [0.7.2] - 2026-05-25

### Fixed

- Fix commits failing when the selected files include a path that is already staged as deleted.

### Tests

- Add coverage for staging unstaged deletions while skipping already staged deleted paths.

## [0.7.1] - 2026-05-23

### Added

- Add the ability for tooltips in the IntelliGit window to respect the "editor.hover.delay" setting from VS Code's settings.json.
- Add "intelligit.tooltips.enabled" setting to optionally completely disable all tooltips inside the IntelliGit window.

### Changed

- Update the TypeScript toolchain to 6.0, switch the extension compiler configuration to Node16 module resolution, and remove a stale React default import surfaced by stricter compiler checks.

## [0.7.0] - 2026-05-23

### Added

- Discover Git repositories inside non-Git workspace folders and add an IntelliGit repository selector for multi-project workspaces.

## [0.6.8] - 2026-05-23

### Added

- Add a commit context menu action to squash an unpushed selected commit range into one commit.
- Add amend commit branch-history context and IntelliJ-style amend actions in the commit panel.

### Fixed

- Use VS Code input theme colors for the commit message box so light themes no longer render a dark textarea.
- Preserve amend commit subjects exactly when parsing branch history, including tabs and surrounding whitespace.
- Restore the original HEAD if squash commit creation fails after the soft reset.

### Tests

- Add coverage for the squash commit menu item and squash command flow.
- Add coverage for amend branch history loading, UI state, and commit subject parsing with separator-safe git log output.
- Add coverage for dismissed rebase prompts and failed push retries after rebase.

## [0.6.6] - 2026-04-30

### Added

- Show an immediate rebase-and-push prompt when a push is rejected because the remote branch contains commits missing locally, matching the IntelliJ IDEA-style recovery flow without requiring a second manual push.

### Tests

- Add coverage for non-fast-forward push rejection detection, the rebase-and-push prompt action, and the `git pull --rebase` GitOps wrapper.

## [0.6.5] - 2026-04-08

### Fixed

- Preserve the last typed commit message text after successful commit flows so reopening the same project restores the draft instead of showing an empty commit message box.

### Tests

- Update commit panel provider coverage to verify successful commit paths keep the persisted commit draft text.

## [0.6.4] - 2026-04-08

### Added

- Persist unsaved commit message drafts per repository so the Commit panel restores the last typed text after closing and reopening the project or restarting VS Code.

### Tests

- Add integration coverage for restoring, saving, and clearing persisted commit drafts in the commit panel provider.

## [0.6.3] - 2026-04-06

### Fixed

- Fix commits failing when VS Code opens a subfolder of a git repository (e.g. opening `/root/client/project2` when the git root is `/root/client`). The extension now discovers the actual git repository root via `git rev-parse --show-toplevel` instead of assuming the workspace folder is the repo root.
- Fix file paths being doubled (e.g. `project2/project2/file.ts`) when opening files, showing diffs, jumping to source, or deleting files from the commit panel in nested workspace scenarios.
- Fix `.git` directory file watchers silently failing to register when the workspace folder differs from the git root, causing auto-refresh to stop working.

## [0.6.2] - 2026-03-16

### Security

- Update `simple-git` to `^3.32.3` to close a remote code execution bypass (GHSA-r275-fr43-pm7q) where a malicious `.git/config` in an opened repository could trigger arbitrary code execution.
- Replace synchronous `spawnSync("git")` branch and tag name validation with a pure JavaScript implementation matching `git check-ref-format` rules, eliminating a 5-second extension host thread block.
- Quote commit hash refs in `terminal.sendText` calls to prevent PowerShell `^` metacharacter injection on Windows.
- Add `--fixed-strings` to `git log --grep` to prevent Regular Expression Denial of Service (ReDoS) via user-supplied search text.
- Add null byte, carriage return, and newline rejection to `assertRepoRelativePath` to close a path injection vector on platforms where null bytes in paths cause ambiguous git behavior.
- Sanitize embedded credentials from URLs in git error messages before displaying them in VS Code notifications, preventing accidental exposure of `https://user:password@host` patterns.
- Use exact equality for full-length (40-character) SHA hash comparison in `isHashMatch` to eliminate prefix collision risk in large repositories.

### Fixed

- Fix infinite loop in the merge editor conflict parser when both sides insert new lines at the same base position, causing the UI to hang permanently.
- Fix in-place mutation of `CommitFile` and `WorkingFile` objects in `getCommitDetail`, `getStatus`, and `getShelvedFiles`, replacing them with immutable spread operations to prevent silent data corruption from any future caching layer.
- Fix `CommitPanelViewProvider.onDidDispose` unconditionally disposing the icon theme even when a newer webview view has already replaced it, which caused the replacement view to lose its icon theme.
- Wrap `vscode.commands.executeCommand("setContext")` calls with `Promise.resolve().catch()` to handle `Thenable` rejection, preventing unhandled rejection crashes during extension host startup.
- Use `vscode.workspace.createFileSystemWatcher` for git refs directory watching on Linux, where `fs.watch` with `recursive: true` silently falls back to non-recursive watching and misses branch/tag changes.
- Fix `buildResultContent` returning a spurious `"\n"` instead of `""` when all merge segments resolve to empty lines with `hasTrailingNewline` enabled.
- Replace unsafe `as CommitFile["status"]` type cast in `getCommitDetail` with validated `mapStatusCode()` to correctly handle unknown git status codes instead of producing invalid runtime values.
- Remove duplicate `EMPTY_TREE_HASH` constant in `diffService.ts` and import from the shared `constants.ts` module.
- Consolidate 14 inline `err instanceof Error ? err.message : String(err)` patterns in `commitCommands.ts` and `CommitGraphViewProvider.ts` to use the centralized `getErrorMessage()` utility.

### Tests

- Add 60 new unit tests covering branch name validation edge cases (git check-ref-format rules), hash comparison with full-length equality, path traversal with control characters, credential URL sanitization, merge editor empty file handling, conflict parser loop safety, and `--fixed-strings` grep behavior.

## [0.6.1] - 2026-03-12

### Fixed

- Release workflow reruns now check whether the current extension version is already published to the VS Code Marketplace or Open VSX and skip that target instead of failing on duplicate publish attempts.
- GitHub release publishing is now idempotent for reruns: existing releases are reused and the VSIX asset is uploaded with overwrite support so partially failed release runs can be resumed safely.

## [0.6.0] - 2026-03-09

### Added

- IntelliJ-style stash accordion layout: each stash entry has a chevron toggle that expands its file tree inline directly below that entry, replacing the previous split list/tree layout.
- Draggable file tree height within expanded stash entries for resizing the file list area.
- Bottom "Coming..." placeholder panel below the Commit/Stash tabs with a draggable divider to resize.
- Bottom panel height persists across webview reloads via `vscode.getState()`.
- Loading indicator shown when stash entry is expanded but files are still being fetched from the extension host.
- Branch name validation with strict alphanumeric/dot/dash/underscore/slash rules for new branch and tag operations.
- Strict relative path assertions for all file operations dispatched from webviews to prevent path traversal.
- Stash shelving now supports untracked files (`--include-untracked` flag on `git stash push`).

### Changed

- Stash branch badge icon changed from tag icon to git branch icon, matching the branch panel.
- Stash branch badge color now uses `--vscode-gitDecoration-modifiedResourceForeground` instead of hardcoded `#d8ca64` for theme compatibility.

### Fixed

- Fixed stale branch metadata causing incorrect push-target resolution in "Push All up to Here": now refreshes branch cache on lookup miss instead of fabricating a synthetic branch object.
- Fixed potential leaked document event listeners and stuck body styles when ShelfTab unmounts mid-drag.

### Refactored

- Extracted `extension.ts` (2,021 lines) into focused modules, reducing it to ~520 lines (75% reduction):
    - `commands/branchCommands.ts`: 10 branch action handlers
    - `commands/commitCommands.ts`: 13 commit context actions
    - `services/diffService.ts`: file comparison and patch operations
    - `services/gitHelpers.ts`: shared git utilities (validation, resolution)
    - `services/jetbrainsMergeService.ts`: JetBrains merge tool orchestration
    - `services/refreshService.ts`: debounced refresh and file watchers
- Decomposed `MergeEditorApp.tsx` (1,477 lines) into focused modules:
    - `icons.tsx`: SVG icon components
    - `wordDiff.ts`: pure word-level diff algorithms
    - `mergeState.ts`: reducer and resolution helpers
    - `segments.tsx`: section components, code blocks, overview rail
- Extracted shared theme change listener utility (`themeListeners.ts`) to replace duplicated listener boilerplate across view providers.
- Removed duplicate stash/shelf method aliases (`stashSave`, `stashPop`, etc.) that were pure pass-throughs to canonical `shelve*` methods.

### Tests

- Added 65+ unit tests for extracted modules: `gitHelpers`, `wordDiff`, `mergeState` (increasing the total from ~131 to ~196).

## [0.5.5] - 2026-03-09

### Added

- Shared "Group by Directory" toggle across Commit and Stash tabs: the toggle state is now lifted to the top-level app so both tabs respect the same setting. (PR #18 by sivertillia)
- Stash tab label renamed from "Shelf" to "Stash" for consistency with standard Git terminology.

### Fixed

- Fixed duplicate "M" (Modified) status row appearing for newly staged files that were edited after staging. Only unstaged modifications are now suppressed for staged-add files; unstaged deletions (`AD` status) are still shown.
- Fixed `vscode.getState()` TypeError in test environments by using optional chaining (`vscode.getState?.()`) in the state initializer and effect.
- Fixed `useEffect` dependency array for `groupByDir` persistence to include `vscode` for React exhaustive-deps compliance.

### Tests

- Added test case verifying `groupByDir` defaults to `true` when `getState()` returns `undefined`.
- Updated VS Code API mocks to include `getState`/`setState` for `CommitPanelApp` test coverage.
- Narrowed overly broad DOM selectors (`querySelectorAll("*")`) in integration tests to use precise `title` attribute and `role="button"` selectors.
- Updated "Shelf" assertions and selectors to "Stash" across all test files.

## [0.5.4] - 2026-03-04

### Fixed

- Fixed commit graph Changed Files double-click behavior so file rows now open a commit-to-parent diff (`<parent> ↔ <commit>`) as expected.
- Wired commit graph webview `openCommitFileDiff` events through the provider and extension host to reuse the same diff-opening path as the Commit Files view.

### Tests

- Added integration coverage for commit graph Changed Files double-click to assert `openCommitFileDiff` messaging and provider event forwarding.

## [0.5.3] - 2026-03-04

### Fixed

- Fixed "ambiguous argument" error in commit graph when a branch used as filter is deleted. The stale branch reference is now cleared and the graph falls back to showing all branches.

## [0.5.2] - 2026-03-04

### Fixed

- Fixed `groupByDir` setting not persisting across webview reloads. The toggle state is now saved to and restored from `vscode.getState()`. (PR #13 by sivertillia)
- Fixed `useCheckedFiles` overwriting all webview state keys on every update. State writes now merge with existing keys instead of replacing them.

## [0.5.1] - 2026-03-04

### Fixed

- Fixed "Too many revisions specified 'stash@{N}'" error when clicking on a file in the shelf (stash) pane. Replaced `git stash show -p` with `git diff stash@{N}^ stash@{N}` for file-level patch retrieval, which correctly handles pathspec filtering across all git versions.

## [0.5.0] - 2026-02-22

### Added

- External JetBrains merge tool integration for merge conflicts (PyCharm/IntelliJ IDEA/WebStorm and other JetBrains IDEs) using Git conflict stages (`base/ours/theirs`) and the IDE `merge` command.
- macOS `.app` bundle path support for JetBrains merge tool configuration, including automatic executable resolution from `Contents/Info.plist` (`CFBundleExecutable`) with fallback scanning of `Contents/MacOS`.
- JetBrains IDE auto-detection for merge tool setup:
    - macOS: `/Applications`, `~/Applications`, and JetBrains Toolbox installs
    - Windows: standard JetBrains install directories and JetBrains Toolbox installs
- `IntelliGit: Detect JetBrains Merge Tool` command with Quick Pick selection of detected JetBrains IDEs and manual-entry fallback.
- Editor context submenu `IntelliGit` (right-click in file editor) with:
    - `Compare with Revision`
    - `Compare with Branch`
- Git file comparison helpers to load file content at a selected revision/branch and open VS Code diffs against the working tree file.

### Changed

- `Open Merge Conflict` now uses only two merge editor paths:
    - JetBrains merge tool (when `intelligit.jetbrainsMergeTool.preferExternal` is enabled and a JetBrains path is configured)
    - VS Code internal merge editor (default fallback)
- IntelliGit custom merge editor is no longer used in the merge-conflict open flow.
- JetBrains merge tool path prompt now validates the entered path immediately and shows the resolved executable path in the confirmation message for easier setup/debugging.
- `intelligit.jetbrainsMergeTool.preferExternal` setting description updated to document VS Code internal merge editor fallback behavior.

### Fixed

- Fixed macOS JetBrains `.app` path launch failures caused by trying to execute the app bundle directory directly (`EACCES`) by resolving the actual binary before launch.
- Fixed merge-conflict command registration syntax regression introduced while wiring JetBrains merge-tool commands.

## [0.4.0] - 2026-02-20

### Added

- Native VS Code file icon theme support across IntelliGit trees, including file, folder, and expanded-folder icons from the active `workbench.iconTheme`.
- Theme icon font support in webviews so icon themes that render glyph-based icons work correctly (not only SVG path icons).
- Folder name specific icon resolution (`folderNames`, `folderNamesExpanded`, `rootFolderNames`, `rootFolderNamesExpanded`) to match native explorer/source-control icon behavior.

### Changed

- Changed Files, Commit Files, Shelf Files, and Branch folder trees now resolve icons through the same native theme mapping path for consistent visuals.
- Commit panel file tree typography (row height, size, spacing, and weight) was adjusted to align with native Source Control list presentation.
- Commit panel now uses VS Code foreground color for commit file names instead of status-colored file-name text, matching native Source Control behavior.

### Fixed

- Fixed cases where folder icons were missing or mismatched in Changed Files and Commit Files despite icon theme support being enabled.
- Fixed icon mismatches for compact/derived folder labels by normalizing folder-name lookup keys and leaf-segment fallbacks.
- Fixed branch tree folder icons not following the active file icon theme mappings.

## [0.3.1] - 2026-02-19

### Added

- Commit graph action types are now strict literal unions (`BranchAction`, `CommitAction`) with runtime guards for safer webview-to-extension messaging.

### Changed

- Marketplace metadata tuned for discoverability while keeping package name/description genericized for safer trademark posture.
- README project structure updated to reflect current modular React layout (`branch-column`, `commit-list`, `commit-panel`, shared modules).
- Commit list rendering switched from full list rendering to viewport virtualization for large-history performance.
- Branch remote-group header rendering now reuses `BranchSectionHeader` for consistent structure and reduced duplication.
- `useCommitGraphCanvas` now derives size from `rows.length` and uses a named left-padding constant.
- `TabBar` shared tab style object hoisted to module scope to avoid per-render reallocation.
- Commit list canvas rendering now clamps to viewport+overscan and redraws on scroll/resize/theme changes.
- Commit list load-more flow now guards against repeated triggers while a prior load is still in flight.

### Fixed

- Branch remote grouping now strips the exact grouped remote prefix instead of always stripping the first path segment.
- Context menu keyboard focus now has an accessible visible indicator (outline + focus ring) instead of suppressing outline.
- Commit info webview message handler now uses explicit discriminant handling before accessing `detail`.
- Branch section headers are now keyboard-accessible (`role="button"`, `tabIndex`, `Enter/Space`, `aria-expanded`).
- HEAD row now supports keyboard activation and keyboard context-menu invocation.
- Main/master icon detection now uses normalized branch short names (handles `origin/main`, etc.).
- Branch highlight regex no longer uses unnecessary global flag.
- Branch name trimming logic now safely handles small max lengths without negative slicing.
- Branch selected-row background now follows VS Code theme token (`--vscode-list-activeSelectionBackground`).
- `useCheckedFiles` folder/section toggle wrappers consolidated through a shared callback.
- `DragResizeOptions` is now exported for external typing/re-export.
- Commit panel tree types no longer store redundant `fileCount`; callsites now derive from `descendantFiles.length`.
- `collectDirPaths` now uses an accumulator to avoid recursive array spreading overhead.
- Commit/branch/context-menu integration tests were hardened with shared jsdom React test utilities and more realistic interaction assertions.

- Extension branch command handlers and commit selection errors now consistently use shared `getErrorMessage(...)`.
- Git numstat/stash-show warnings now log via a shared IntelliGit output channel (with fallback) instead of silent/console-only catches.
- Status/numstat failures now provide short user-facing warnings when displayed diff statistics may be incomplete.

## [0.3.0] - 2026-02-18

### Added

- IntelliJ-style commit context menu actions in Commit Graph:
    - Copy Revision Number
    - Create Patch
    - Cherry-Pick
    - Checkout main/default branch
    - Checkout Revision
    - Reset Current Branch to Here
    - Revert Commit
    - New Branch
    - New Tag
    - Undo Commit (unpushed only)
    - Edit Commit Message (unpushed only)
    - Drop Commits (unpushed only)
    - Interactively Rebase from Here (unpushed only)
- Commit action enable/disable rules based on commit state (pushed/unpushed/merge) to match IntelliJ behavior.
- Merge-commit-specific handling in commit menus and disabled states.
- Branch panel inline search box with:
    - live case-insensitive substring filtering
    - highlighted match segments in branch names
    - clear (`x`) button
- `react-icons` integration for branch search/clear glyphs.

### Changed

- Major visual parity pass toward IntelliJ/PyCharm across:
    - Commit panel
    - Branch panel
    - Context menus
    - Shelf tab
- Branch context menu layout:
    - tighter left padding and reduced extra gutter
    - improved popup placement near branch row icon/right-click anchor
    - stronger shadow/depth treatment
- Branch panel header:
    - reduced spacing under search/header area
    - `HEAD` label now shows current branch name (`HEAD (<branch>)`)
- Branch panel typography/spacing:
    - reduced row vertical padding and margins for denser tree layout
    - improved indentation for nested branch folders and branch children
- Commit panel typography:
    - standardized Chakra fonts to VS Code font variables for consistent family across panels.
- Commit files tree and shelf list styling aligned closer to IntelliJ row heights, spacing, selection color, and button geometry.
- Toolbar/icon spacing and visual alignment across commit/shelf tabs.

### Removed

- Branch context menu option: `Compare with '<branch>'`.
- Branch context menu option: `Show Diff with Working Tree`.
- Related extension command contributions and handlers for both removed options.
- Extra icons/actions next to `Amend` in commit area (as requested).

### Fixed

- Commit files tree collapse behavior:
    - collapsed folders no longer auto-expand unexpectedly
    - collapse all now preserves expected root visibility behavior
- Checkbox visual/size consistency in commit files tree:
    - reduced size to better match folder icon scale and IntelliJ feel.
- Changed Files interactions:
    - clicking files opens diff reliably
    - context menus restored after regressions (instead of default browser menu)
- Commit files tree indentation:
    - reduced over-indentation for deeper nested paths.
- Branch tree indentation:
    - improved child branch indentation under grouped prefixes.
- Commit panel path wrapping/truncation:
    - long path segments use available width better, with reduced unwanted wrapping.
- Context menu layout regressions:
    - corrected item spacing, ordering, disabled-state styling, and alignment.
- Right-click context behavior on:
    - commit rows
    - changed files
    - branches
- Shelf panel behavior:
    - shelf actions and layout corrected
    - shelf file changes displayed in tree format like Changed Files
    - apply/pop/delete controls and styling aligned.
- Dotfile icon detection:
    - files like `.eslintrc.json` now resolve to correct extension icon (`json`) instead of generic dotfile fallback.
- JSON badge token conflict:
    - JSON label is now distinct from JavaScript badge text.
- Context menu viewport clamping:
    - reposition recalculates when menu item count/content changes.

- File context command handlers now have safer async error handling:
    - `fileRollback`
    - `fileShelve`
    - `fileShowHistory`
    - success/info and error feedback are surfaced consistently.
- `fileDelete` error handling now discriminates expected “not tracked/pathspec” cases from unexpected errors.
- Workspace safety guard added for webview file operations:
    - avoids crashes when no workspace folder is open.
- `git rm` behavior made safer:
    - `deleteFile` supports optional `force`
    - default path avoids forced deletion of modified files.

### Architecture and Maintainability

- Continued migration toward reusable React components and shared styling patterns.
- Centralized/shared context menu and tree rendering improvements used across panels.
- Multiple UI consistency passes to reduce raw/one-off styling divergence and improve production readiness.

## [0.1.2] - 2026-02-16

### Added

- Marketplace icon (256x256 PNG with dark blue background and git branch design)

### Fixed

- Extension displayed default placeholder icon on VS Code Marketplace

## [0.1.1] - 2026-02-16

### Fixed

- Triggered first marketplace release (version bump required after adding repository secrets)

## [0.1.0] - 2026-02-16

### Added

#### Commit Panel (Sidebar)

- Tabbed interface with Commit and Shelf tabs
- File tree with directory grouping, collapsible folders, and indent guide lines
- Per-file checkboxes for selective staging at section, folder, and individual file level
- Checkbox state persistence across navigation via webview state
- File type icon badges with colored backgrounds for 20+ file types
- Status-colored filenames (modified, added, deleted, renamed, conflicting, untracked)
- Addition/deletion stats per file
- Single-click file to open diff view
- Toolbar with Refresh, Rollback, Group by Directory, Shelve, Show Diff, Expand All, Collapse All
- Amend mode with auto-filled last commit message
- Commit and Commit & Push buttons
- Drag-resizable divider between file list and commit message area

#### Shelf (Stash) System

- Create shelves with custom messages
- Partial shelf support (stash only selected files)
- Apply, Pop (apply + remove), and Delete operations per shelf
- Formatted timestamps and stash count badge on tab

#### Commit Graph (Bottom Panel)

- Two-column resizable layout with branch tree and commit list
- Canvas-rendered lane-based commit graph with bezier merge curves
- Ring-style commit dots with 10 rotating lane colors
- Retina/HiDPI display support
- Ref badges for HEAD, tags, remote branches, and local branches
- Text and hash search with debounced filtering
- Infinite scroll with 500-commit pagination
- Click commit to load changed files and details

#### Branch Column

- Hierarchical branch tree with HEAD, Local, and Remote sections
- Prefix-based folder grouping for branch names
- Current branch highlighted with tracking info (ahead/behind badges)
- Click branch to filter graph; right-click for branch operations
- Custom context menu with full branch management
- Drag-resizable column width

#### Changed Files (Bottom Panel)

- Directory tree with status icons (Added, Modified, Deleted, Renamed, Copied)
- Per-file addition/deletion line counts
- Indent guide lines matching VS Code native tree style
- Drag-resizable divider between file tree and commit details
- Collapsible commit details section with message, hash, author, email, date

#### Branch Management (Sidebar Tree View)

- HEAD indicator with current branch and short hash
- Local and remote branches with tracking info
- Context menu: Checkout, New Branch, Checkout and Rebase, Compare, Show Diff, Rebase, Merge, Update, Push, Rename, Delete

#### General

- Activity bar icon with changed file count badge
- Auto-refresh via debounced file system watcher (300ms)
- Keyboard shortcut Alt+9 to open IntelliGit views
- Content Security Policy enforced in all webviews

#### CI/CD

- GitHub Actions workflow for build validation on PRs
- Dual marketplace publishing (VS Code Marketplace + Open VSX) on version bump to main
- Automatic git tagging and GitHub Release creation with VSIX attachment
