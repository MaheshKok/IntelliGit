# Security Findings Documentation

## Executive Summary

The repository-wide Codex Security scan found 9 reportable findings and 1 suppressed group.

## Remediation Update

As of June 5, 2026, all 9 reportable findings listed below have been fixed in the current working tree. The fixes cover branch/ref and remote validation, no-upstream push retry handling, JetBrains merge tool configuration scope and path validation, literal Git pathspec handling, GitLab clone host binding, NUL-delimited commit parsing, workspace-contained repository discovery, merge-conflict path preservation, and spreadsheet-safe localization CSV output.

Validation completed for the remediation:

- Focused regression suite: `bun vitest run tests/unit/gitops.test.ts tests/unit/gitHelpers.test.ts tests/unit/repositoryDiscovery.test.ts tests/unit/jetbrainsMergeService.test.ts tests/unit/jetbrainsMergeTool.test.ts tests/unit/cloneService.test.ts tests/unit/extension.integration.test.ts tests/unit/localization.test.ts`
- Standard checks: `bun run format:check`, `bun run lint`, `bun run architecture:check`, `bun run typecheck`, `bun run build`, `bun run test`
- Localization checks: `bun run l10n:translate -- --only-missing --quiet`, `bun run l10n:import -- --quiet`, `bun run l10n:validate -- --quiet`, `bun run l10n:audit`
- GitNexus change detection: `npx --yes gitnexus detect-changes --repo <repo-root>`

| Severity | Count |
|---|---:|
| High | 3 |
| Medium | 5 |
| Low | 1 |

| Confidence | Count |
|---|---:|
| High | 8 |
| Medium | 1 |

Formal reports:

- Markdown: `<scan-dir>/report.md`
- HTML: `<scan-dir>/report.html`

Supporting ledgers:

- Dedupe: `<scan-dir>/artifacts/04_reconciliation/dedupe_report.md`
- Validation: `<scan-dir>/artifacts/04_reconciliation/validation_report.md`
- Attack path: `<scan-dir>/artifacts/04_reconciliation/attack_path_report.md`

## Priority Order

Fix these first:

1. FIND-001: option-like local branch refs can reach Git and, in the rebase path, execute commands.
2. FIND-002: no-upstream push retry can replay option-like remote names from Git config.
3. FIND-003: workspace configuration can steer JetBrains merge tool execution.

Then fix repository-integrity and boundary issues:

4. FIND-004: Git pathspec magic in file actions.
5. FIND-007: repository discovery outside workspace.
6. FIND-008: merge conflict path trimming.
7. FIND-006: commit log delimiter injection.
8. FIND-005: GitLab token host binding.
9. FIND-009: CSV formula neutralization.

## Findings Table

| ID | Severity | Confidence | Title | Raw candidates | Main affected files |
|---|---|---|---|---|---|
| FIND-001 | High | High | Option-like local branch refs reach Git without end-of-options protection | CAND-S009-1, CAND-S009-2, CAND-S012-1 | `src/commands/branchCommands.ts`, `src/services/gitHelpers.ts`, `src/git/operations.ts` |
| FIND-002 | High | High | No-upstream push retry replays option-like remote names from Git config | CAND-S010-1 | `src/git/operations.ts` |
| FIND-003 | High | High | Workspace configuration can launch a repository-controlled JetBrains merge tool executable | CAND-S014-1 | `package.json`, `src/services/jetbrainsMergeService.ts`, `src/utils/jetbrainsMergeTool.ts` |
| FIND-004 | Medium | High | Git pathspec magic in file actions can mutate sibling files | CAND-S008-1, CAND-S008-2, CAND-S008-3, CAND-S008-4, CAND-S008-5, CAND-S014-2, CAND-S016-1, CAND-S016-2, CAND-S016-3, CAND-S016-4, CAND-S016-5, CAND-S016-6, CAND-S017-1, CAND-S017-2, CAND-S017-3 | `src/git/operations.ts`, `src/views/panelFileActions.ts`, `src/views/commitPanelActions.ts` |
| FIND-005 | Medium | Medium | GitLab clone flow can send a GitLab token to arbitrary HTTPS clone hosts | CAND-S011-1 | `src/services/cloneService.ts`, `src/services/gitAskpass.ts` |
| FIND-006 | Medium | High | Commit log parser accepts record and field separators from commit subjects | CAND-S011-2 | `src/git/parsers.ts`, `src/git/operations.ts`, `src/views/CommitPanelViewProvider.ts` |
| FIND-007 | Medium | High | Repository discovery can select a Git worktree outside the workspace | CAND-S013-3 | `src/git/operations.ts`, `src/services/repositoryDiscovery.ts` |
| FIND-008 | Medium | High | Merge conflict session trims paths before privileged actions | CAND-S031-1 | `src/views/MergeConflictSessionPanel.ts`, `src/git/operations.ts` |
| FIND-009 | Low | High | Localization CSV output does not neutralize spreadsheet formulas | CAND-S007-1 | `AGENTS.md`, `scripts/localization-csv.js` |

## FIND-001: Option-like local branch refs reach Git without end-of-options protection

| Field | Value |
|---|---|
| Severity | High |
| Confidence | High |
| CWE | CWE-88 Improper Neutralization of Argument Delimiters in a Command |
| Category | Git option injection / command execution |
| Raw candidates | CAND-S009-1, CAND-S009-2, CAND-S012-1 |
| Affected lines | `src/commands/branchCommands.ts:228`; `src/services/gitHelpers.ts:244`; `src/git/operations.ts:116-140` |
| Validation artifacts | `_validation_shared/branch_option_poc.log`; `_validation_shared/rebase_exec_poc.log`; `_validation_shared/branch_option_checkout_track_poc.log` |

### Issue

Existing branch names are parsed from Git output and later passed into high-risk Git commands as arguments. A raw local ref whose short name starts with `-` can be interpreted by Git as an option rather than branch data.

### Validated Impact

The scan validated two concrete behaviors:

- A raw local ref named `-f` caused `git checkout -f` semantics and discarded a dirty file.
- A raw local ref named like `--exec=touch${IFS}/tmp/...` reached `git rebase` and executed the command.

The scan also found counterevidence: a normal clone/fetch left option-like refs as remote-tracking refs, and `git checkout --track` refused to create invalid local branch names. The strongest exploit path therefore requires a prepared local repository with raw local refs already present in `.git` metadata.

### Attack Path

1. Attacker prepares or influences local Git metadata with an option-like local branch ref.
2. IntelliGit parses that branch into a `Branch` object.
3. User triggers a checkout, rebase, merge, push, delete, or update action involving that branch.
4. The extension sends the branch name to Git without validating it as a safe ref data argument.
5. Git interprets the value as command structure.

### Fix

- Validate existing branch names before every branch action, not only newly created branch names.
- Reject branch names that fail `isValidBranchName`, start with `-`, or start with `+` where short names could otherwise become force refspecs.
- Add `--end-of-options` where the target Git command supports it.
- Add regression tests using raw refs named `-f` and `--exec=touch${IFS}/tmp/poc`.

## FIND-002: No-upstream push retry replays option-like remote names from Git config

| Field | Value |
|---|---|
| Severity | High |
| Confidence | High |
| CWE | CWE-88 Improper Neutralization of Argument Delimiters in a Command |
| Category | Git option injection / command execution |
| Raw candidates | CAND-S010-1 |
| Affected lines | `src/git/operations.ts:333-341`; `src/git/operations.ts:641-648` |
| Validation artifacts | `_validation_shared/push_suggestion_option_poc.log`; `_validation_shared/push_exact_replay_with_config_poc.log` |

### Issue

The push retry path parses Git stderr for a suggested `git push --set-upstream ...` command. It then reuses the parsed remote and branch without proving those values are safe data arguments.

### Validated Impact

The scan showed that `remote.pushDefault` can make Git suggest a command containing an option-like remote value, and that the extension-style replay can execute a local marker command through `--receive-pack`.

### Attack Path

1. Attacker controls `.git/config` or equivalent local repo Git config.
2. The repository has a branch with no upstream.
3. User attempts push.
4. Git emits an upstream suggestion containing an option-like remote name.
5. IntelliGit parses the suggestion and asks the user to accept the upstream setup.
6. If accepted, the extension replays the parsed values as Git arguments.
7. Git interprets the leading-dash remote as push option structure.

### Fix

- Do not parse and replay Git command suggestions from stderr.
- Resolve the current branch and default remote using trusted Git APIs.
- Validate remote names and branch names before push retry.
- Reject remote names beginning with `-` or containing control characters.
- Add a regression test where `remote.pushDefault` starts with `--receive-pack`.

## FIND-003: Workspace configuration can launch a repository-controlled JetBrains merge tool executable

| Field | Value |
|---|---|
| Severity | High |
| Confidence | High |
| CWE | CWE-78 OS Command Injection |
| Category | Workspace configuration command execution |
| Raw candidates | CAND-S014-1 |
| Affected lines | `package.json:476-484`; `src/services/jetbrainsMergeService.ts:210-268`; `src/utils/jetbrainsMergeTool.ts:457-474` |
| Validation artifact | `_validation_shared/jetbrains_relative_spawn_poc.log` |

### Issue

The JetBrains merge tool path is a VS Code configuration setting. Because the setting is not restricted to a machine/user-only scope, a repository workspace setting can point to a repo-controlled executable.

### Validated Impact

The scan created an executable `./pwn-tool` in a temporary repository and showed that spawning a relative configured tool path with `cwd` set to the repository root executes that repository file.

`shell: false` blocks shell metacharacter injection, but it does not block execution of a configured file path.

### Attack Path

1. Attacker commits workspace settings that set the JetBrains merge tool path to a relative executable.
2. Attacker includes that executable in the repository.
3. User opens the workspace and invokes the JetBrains conflict action.
4. The extension reads workspace configuration and spawns the path.
5. The repository-controlled executable runs with local user privileges.

### Fix

- Make the setting machine/application scoped, or ignore workspace/folder values by reading configuration inspection data and accepting only global/user values.
- Require an absolute existing binary or a detected JetBrains app bundle.
- Reject relative paths at launch time.
- Add tests for workspace-configured `./tool` values.

## FIND-004: Git pathspec magic in file actions can mutate sibling files

| Field | Value |
|---|---|
| Severity | Medium |
| Confidence | High |
| CWE | CWE-88 Improper Neutralization of Argument Delimiters in a Command |
| Category | Git pathspec injection / unintended file mutation |
| Raw candidates | CAND-S008-1, CAND-S008-2, CAND-S008-3, CAND-S008-4, CAND-S008-5, CAND-S014-2, CAND-S016-1, CAND-S016-2, CAND-S016-3, CAND-S016-4, CAND-S016-5, CAND-S016-6, CAND-S017-1, CAND-S017-2, CAND-S017-3 |
| Affected lines | `src/git/operations.ts:307-312`; `src/git/operations.ts:319-322`; `src/git/operations.ts:462-473`; `src/git/operations.ts:482-487`; `src/git/operations.ts:627-634`; `src/views/panelFileActions.ts:45-59`; `src/views/panelFileActions.ts:102-115` |
| Validation artifacts | `_validation_shared/pathspec_magic_poc.log`; `_validation_shared/pathspec_clean_poc.log` |

### Issue

The extension validates repository-relative paths for traversal and control characters, but those strings are still Git pathspecs. Git pathspec magic such as `:(glob)*` remains active even after the standard `--` path separator.

### Validated Impact

The scan showed that:

- `git add -- :(glob)*` staged sibling files.
- `git rm -f -- :(glob)*` removed sibling files.
- `git stash` captured sibling changes.
- `git clean -fd -- :(glob)*` removed matching untracked siblings.

### Attack Path

1. Malicious repository contains a filename such as `:(glob)*`.
2. User selects what appears to be one file in a file action UI.
3. The extension validates it as a repository-relative path.
4. The extension sends it to Git after `--`.
5. Git treats it as a pathspec expression and applies the action to matching siblings.

### Fix

- Use literal pathspec handling for user-selected paths, including selected commit-file patch generation.
- Options include `git --literal-pathspecs`, `GIT_LITERAL_PATHSPECS=1` for path operations, or a verified literal pathspec encoding.
- Add regression tests with filenames `:(glob)*`, sibling tracked files, and sibling untracked files across stage, unstage, rollback, stash, delete, commit selected, and conflict accept actions.

## FIND-005: GitLab clone flow can send a GitLab token to arbitrary HTTPS clone hosts

| Field | Value |
|---|---|
| Severity | Medium |
| Confidence | Medium |
| CWE | CWE-200 Exposure of Sensitive Information to an Unauthorized Actor |
| Category | Credential forwarding to attacker-controlled endpoint |
| Raw candidates | CAND-S011-1 |
| Affected lines | `src/services/cloneService.ts:437-461`; `src/services/cloneService.ts:527-540`; `src/services/gitAskpass.ts:61-67` |
| Validation method | Static source trace |

### Issue

The GitLab clone flow prompts for or reuses a GitLab token, then accepts any HTTPS clone URL. The token is then supplied through askpass for that URL, without binding the token to `gitlab.com` or a selected self-managed GitLab host.

### Impact

If a user enters or selects an attacker-controlled HTTPS clone URL in the GitLab flow, the extension can provide the GitLab token to that host when Git asks for credentials.

The scan did not run a live HTTPS credential-capture server, so this is medium confidence rather than high confidence.

### Attack Path

1. User chooses GitLab clone flow.
2. User enters or reuses a GitLab personal access token.
3. User provides an attacker-controlled HTTPS clone URL.
4. Extension passes the token to Git askpass for that URL.
5. Git may send the token to the attacker-controlled host during authentication.

### Fix

- Bind GitLab tokens to a hostname.
- If only GitLab.com is supported, require `gitlab.com` clone URLs.
- If self-managed GitLab is supported, ask for and store tokens per GitLab base URL.
- Refuse to use a token when the clone URL hostname differs from the authenticated GitLab host.

## FIND-006: Commit log parser accepts record and field separators from commit subjects

| Field | Value |
|---|---|
| Severity | Medium |
| Confidence | High |
| CWE | CWE-116 Improper Encoding or Escaping of Output |
| Category | Parser delimiter injection / UI integrity spoofing |
| Raw candidates | CAND-S011-2 |
| Affected lines | `src/git/parsers.ts:16-38`; `src/git/operations.ts:152-176`; `src/views/CommitPanelViewProvider.ts:396-423` |
| Validation artifact | `_validation_shared/commit_separator_poc.log` |

### Issue

The commit log parser uses raw ASCII record and field separators in `git log --format` output. Git commit subjects can contain those bytes, so a malicious subject can split one real Git log row into a synthetic parsed row.

### Validated Impact

The scan created a commit subject containing the record and field separators. The parser returned a spoofed row with attacker-chosen-looking metadata, including hash, subject, author, and refs.

### Attack Path

1. Attacker contributes a commit with separator bytes in the subject.
2. Git log output embeds that subject into the separator-delimited format.
3. Parser splits on attacker-controlled separator bytes.
4. UI displays a synthetic row.
5. If the synthetic hash maps to a real commit hash, user actions can be presented with misleading metadata.

### Fix

- Use NUL-delimited records and fields, because Git commit messages cannot contain NUL.
- Alternatively encode each field unambiguously before parsing.
- Validate selected commit hashes against the actual loaded commit set before privileged commit actions.

## FIND-007: Repository discovery can select a Git worktree outside the workspace

| Field | Value |
|---|---|
| Severity | Medium |
| Confidence | High |
| CWE | CWE-22 Improper Limitation of a Pathname to a Restricted Directory |
| Category | Workspace boundary confusion |
| Raw candidates | CAND-S013-3 |
| Affected lines | `src/git/operations.ts:60-63`; `src/services/repositoryDiscovery.ts:28-31`; `src/services/repositoryDiscovery.ts:54-64` |
| Validation artifact | `_validation_shared/repository_discovery_outside_worktree_poc.log` |

### Issue

Repository discovery scans under workspace roots, but then trusts Git's resolved top-level path. `git rev-parse --is-inside-work-tree` can exit successfully while printing `false`, and `--show-toplevel` can point outside the VS Code workspace through Git indirection.

### Validated Impact

The scan built a disposable workspace with a `.git` file and `core.worktree` indirection. The root resolved outside the workspace while the code path treated the successful command as repository proof.

### Attack Path

1. Malicious workspace contains `.git` metadata pointing outside the workspace.
2. Repository discovery sees a `.git` marker under the opened workspace.
3. `isRepository` checks command success but not that stdout is exactly `true`.
4. `getRepositoryRoot` returns an outside path.
5. The extension may run Git and file actions against a directory the user did not open.

### Fix

- Require `rev-parse --is-inside-work-tree` output to equal `true`.
- Realpath the resolved top-level directory.
- Require resolved root containment inside a VS Code workspace root unless the user explicitly selects and confirms an outside repository.

## FIND-008: Merge conflict session trims paths before privileged actions

| Field | Value |
|---|---|
| Severity | Medium |
| Confidence | High |
| CWE | CWE-178 Improper Handling of Equivalent Path Variants |
| Category | Path canonicalization mismatch / unintended file mutation |
| Raw candidates | CAND-S031-1 |
| Affected lines | `src/views/MergeConflictSessionPanel.ts:179-182`; `src/views/MergeConflictSessionPanel.ts:140-163`; `src/git/operations.ts:627-630` |
| Validation artifact | `_validation_shared/merge_conflict_trim_poc.log` |

### Issue

Git paths can legally begin or end with spaces. The merge conflict session React UI preserves exact paths, but the host trims `msg.filePath` before validation and privileged actions.

### Validated Impact

The scan created conflicts in both `foo` and a trailing-space path. Simulating the host trim resolved `foo` while leaving the intended trailing-space file conflicted.

### Attack Path

1. Malicious repository contains paths differing only by leading or trailing spaces.
2. Merge creates conflicts in those paths.
3. User selects the spaced path in the conflict session.
4. Host trims the path before validation.
5. Git operations run on the wrong file.

### Fix

- Do not trim repository paths.
- Reject only the exact empty string as invalid.
- Preserve leading and trailing spaces through validation and Git operations.
- Render whitespace-visible filenames in the UI so users can distinguish them.
- Add tests with conflicts in `foo` and `foo `.

## FIND-009: Localization CSV output does not neutralize spreadsheet formulas

| Field | Value |
|---|---|
| Severity | Low |
| Confidence | High |
| CWE | CWE-1236 Improper Neutralization of Formula Elements in a CSV File |
| Category | CSV formula injection in review workflow |
| Raw candidates | CAND-S007-1 |
| Affected lines | `AGENTS.md:4-8`; `scripts/localization-csv.js:576-590` |
| Validation artifact | `_validation_shared/csv_formula_format_poc.log` |

### Issue

The localization workflow documents importing `docs/localization/localization_translation_review.csv` into Google Sheets. The CSV writer quotes fields for CSV syntax, but it does not neutralize formula-leading cells such as `=`, `+`, `-`, or `@`.

### Validated Impact

The formatter probe showed values such as `-2+3` and `@cmd` are emitted unchanged, and `=IMPORTDATA(...)` is only CSV-quoted. Spreadsheet tools may still evaluate those cells as formulas after import.

### Attack Path

1. Attacker influences a localization/catalog value.
2. Value begins with a spreadsheet formula prefix.
3. `scripts/localization-csv.js` writes it to `docs/localization/localization_translation_review.csv`.
4. Reviewer imports or opens the CSV in a spreadsheet as documented.
5. Spreadsheet evaluates the formula.

### Fix

- Reject formula-leading values during validation, or use an explicit reversible review escape.
- Apply checks to fields that leave the repo for spreadsheet review.
- Add tests for values beginning with `=`, `+`, `-`, `@`, and optional leading whitespace before those characters.

## Suppressed Group: SUPP-001

| Field | Value |
|---|---|
| Decision | Suppressed / ignored |
| Confidence | High |
| Raw candidates | CAND-S013-1, CAND-S013-2 |
| Title | Publish flow trusts provider-returned clone URLs from pinned provider APIs |
| Main files | `src/services/publishService.ts` |

### Why It Was Suppressed

The candidate concerned provider-returned clone URLs in the publish flow. Validation found that the clone URL source is an authenticated, pinned GitHub or GitLab API endpoint rather than repository-controlled data.

The remaining exploit requirement would be provider compromise, TLS compromise, or a malicious authenticated provider response. That is outside the practical repository/content-attacker model used for this scan.

## Coverage Summary

The scan reviewed the following security surfaces:

| Surface | Outcome |
|---|---|
| Extension activation and command registration | Reported issues in branch/update/push surfaces |
| Webview message boundary | Reported file action and merge-conflict path issues |
| Webview HTML, CSP, and i18n payload | No issue found |
| Git executor and operations | Reported option/pathspec/parser issues |
| Branch commands | Reported option-like branch issue |
| Commit basic actions | Reported pathspec issue in selected-file flows |
| Commit history actions | Reported commit-log parser issue |
| Clone flow | Reported GitLab token host-binding issue |
| Publish flow | Provider-returned URL candidates suppressed |
| Git askpass | No standalone issue; contributes to GitLab token finding |
| JetBrains merge tool integration | Reported workspace-configured executable issue |
| Merge conflict parser/editor | Reported pathspec and trim issues |
| Repository discovery | Reported outside-worktree boundary issue |
| Diff and file content services | No issue found |
| Build and packaging scripts | No issue found |
| Localization pipeline | Reported CSV formula issue |
| CI and release workflow | No issue found |
| Ignored local tool caches | Excluded as not tracked product runtime |

## Validation Gaps And Residual Risk

- FIND-005 did not include a live HTTPS credential-capture proof, so confidence remains medium.
- FIND-001 includes counterevidence that normal clone/fetch does not automatically turn remote option-like refs into invalid local branch names.
- The scan did not fix or retest patched code; it reports current vulnerabilities from the scanned revision.
- The scan did not treat ignored local tool caches as product runtime source.

## Recommended Fix Validation

After fixes, run focused regression tests before broad validation:

| Finding | Focused regression |
|---|---|
| FIND-001 | Raw local refs named `-f` and `--exec=...` cannot be used by checkout/rebase/update actions |
| FIND-002 | `remote.pushDefault=--receive-pack=...` cannot be replayed into `git push` |
| FIND-003 | Workspace/folder configured JetBrains merge tool path is ignored or rejected; relative paths fail |
| FIND-004 | Filename `:(glob)*` is treated as one literal file across stage/unstage/rollback/stash/delete/commit/conflict actions |
| FIND-005 | GitLab token is only used for the authenticated GitLab host |
| FIND-006 | Commit subjects containing separator bytes cannot create synthetic parsed commits |
| FIND-007 | `.git` worktree indirection outside workspace is rejected or explicitly confirmed |
| FIND-008 | Conflict paths with leading/trailing spaces remain exact through host actions |
| FIND-009 | CSV formula-leading cells are rejected or escaped before spreadsheet review |
