# Security Scan Process Documentation

## Purpose

This document records how the Codex Security scan of IntelliGit was run, which skills and agents were used, what prompts and artifacts were produced, what validation was performed, and where the final evidence lives.

The companion findings document is:

`<scan-dir>/SECURITY_FINDINGS_DOCUMENTATION.md`

The formal scan reports are:

- Markdown: `<scan-dir>/report.md`
- HTML: `<scan-dir>/report.html`

## Scan Metadata

| Field | Value |
|---|---|
| Repository | `<repo-root>` |
| Product | IntelliGit VS Code extension |
| Scan type | Repository-wide Codex Security scan |
| Scope | Tracked files under the repository root |
| Scan directory | `<scan-dir>` |
| Scan id | `<scan-id>` |
| User authorization | Explicitly authorized subagents and artifact writes under the repository security scan artifact directory |
| Source modifications | None during the security scan |
| Final repository status | Clean after scan; an early PoC `core.worktree` config change was removed |
| Final result | 9 reportable findings, 1 suppressed group |
| Completion accounting | 185 of 185 tracked review rows closed; 27 raw candidates; 10 deduped groups |

## Objective Used

The scan was run under this Codex goal:

```text
Run the Codex Security repository scan for <repo-root>; do not stop until every in-scope file/worklist row has a completion receipt or explicit deferred closure, every candidate has required ledger receipts, and the final report is written.
```

The goal was completed after the final Markdown and HTML reports were written and after closure checks confirmed:

- 185 coverage receipts existed for 185 tracked files.
- Every raw candidate had discovery, validation, and attack-path receipts.
- `report.md` and `report.html` existed.
- Report format validation passed.

Goal usage recorded at completion:

| Metric | Value |
|---|---|
| Tokens | 993,218 |
| Elapsed time | 3,417 seconds |

## Skills And Guidance Used

The top-level skill was:

- `codex-security:security-scan`
- File: `<codex-security-plugin-dir>/skills/security-scan/SKILL.md`

The scan followed the phase sequence required by that skill:

1. Threat model
2. Finding discovery
3. Validation
4. Attack-path analysis
5. Final report generation

Supporting Codex Security skills and references used:

| Purpose | Path |
|---|---|
| Scan artifact conventions | `<codex-security-plugin-dir>/references/scan-artifacts.md` |
| Shared hard rules | `<codex-security-plugin-dir>/references/shared-hard-rules.md` |
| Threat model workflow | `<codex-security-plugin-dir>/skills/threat-model/SKILL.md` |
| Threat model guidance | `<codex-security-plugin-dir>/skills/threat-model/references/threat-model-guidance.md` |
| Finding discovery workflow | `<codex-security-plugin-dir>/skills/finding-discovery/SKILL.md` |
| Repository-wide scan workflow | `<codex-security-plugin-dir>/skills/security-scan/references/repository-wide-scan.md` |
| Validation workflow | `<codex-security-plugin-dir>/skills/validation/SKILL.md` |
| Validation guidance | `<codex-security-plugin-dir>/skills/validation/references/validation-guidance.md` |
| Attack-path workflow | `<codex-security-plugin-dir>/skills/attack-path-analysis/SKILL.md` |
| Severity policy | `<codex-security-plugin-dir>/skills/attack-path-analysis/references/severity-policy.md` |
| Attack-path facts | `<codex-security-plugin-dir>/skills/attack-path-analysis/references/attack-path-facts.md` |
| Final report format | `<codex-security-plugin-dir>/references/final-report.md` |

Repository guidance used:

- `<repo-root>/AGENTS.md`
- `<codex-home>/RTK.md`, referenced from `AGENTS.md`

Security-relevant repository guidance that influenced the scan:

- Static localization catalogs are product data; do not add runtime translation in the extension.
- Localization CSV review through Google Sheets is part of the documented workflow.
- GitNexus tools are normally required before code edits, but this scan did not edit source symbols.
- External review feedback must be verified against current code before acting.
- Do not fabricate test results, citations, file contents, or command output.

## Tools And Agent Types Used

| Tool / Agent | Use |
|---|---|
| Main Codex agent | Orchestrated scan phases, reconciled ledgers, validated candidates, generated final reports |
| Codex Security skills | Provided scan workflow, artifact layout, validation rubric, severity policy, final report expectations |
| Multi-agent subagents | Per-shard repository file review during discovery |
| Shell commands | Local code inspection, Git PoCs, artifact checks, report validation, HTML rendering |
| `git` | Generated tracked-file inventory and disposable repositories for PoCs |
| `jq` | Validated subagent JSON output in some shard results |
| Codex Security scripts | Validated `report.md` format and rendered `report.html` |

The user explicitly authorized subagents for this scan.

## Artifact Layout

The scan used the Codex Security artifact layout:

| Directory / File | Purpose |
|---|---|
| `artifacts/01_context/` | Threat model, scan path metadata, seed research |
| `artifacts/02_discovery/` | Ranked input, shard files, subagent outputs, raw candidates, work ledger |
| `artifacts/03_coverage/` | Repository coverage ledger and reviewed surface summary |
| `artifacts/04_reconciliation/` | Dedupe, validation closure, attack-path closure |
| `artifacts/05_findings/` | Per-candidate and per-finding validation and attack-path reports |
| `report.md` | Final Markdown security report |
| `report.html` | Final HTML security report |
| `report_validation.md` | Final report validation note |

Primary artifact paths:

```text
<scan-dir>/artifacts/01_context/threat_model.md
<scan-dir>/artifacts/01_context/seed_research.md
<scan-dir>/artifacts/02_discovery/rank_input.csv
<scan-dir>/artifacts/02_discovery/deep_review_input.csv
<scan-dir>/artifacts/02_discovery/shard_manifest.json
<scan-dir>/artifacts/02_discovery/work_ledger.jsonl
<scan-dir>/artifacts/02_discovery/raw_candidates.jsonl
<scan-dir>/artifacts/03_coverage/repository_coverage_ledger.md
<scan-dir>/artifacts/04_reconciliation/dedupe_report.md
<scan-dir>/artifacts/04_reconciliation/validation_report.md
<scan-dir>/artifacts/04_reconciliation/attack_path_report.md
```

## Phase 1: Threat Model

The scan generated and used a repository-specific threat model for IntelliGit.

Artifacts:

- Repository-scoped threat model: `<scan-artifacts-root>/threat_model.md`
- Per-scan copy: `<scan-dir>/artifacts/01_context/threat_model.md`
- Seed research: `<scan-dir>/artifacts/01_context/seed_research.md`

The threat model identified these main assets and boundaries:

- Local repository contents, branch state, remotes, stashes, conflict state, and uncommitted work.
- VS Code extension host privileges.
- Git command orchestration boundary.
- Webview-to-extension-host message boundary.
- Clone/publish credential handling.
- Git askpass secret boundary.
- JetBrains merge tool external process boundary.
- Build, packaging, localization, and release workflows.

`seed_research.md` recorded that no external CVE, GHSA, advisory, or package-version seeds were driving this scan.

## Phase 2: Finding Discovery

Discovery created a tracked-file worklist using `git ls-files`.

The initial generator also produced ignored local tool-cache rows. Those were excluded from canonical coverage, but preserved for auditability:

- Generated with ignored rows: `artifacts/02_discovery/rank_input.generated_with_ignored.csv`
- Excluded ignored rows: `artifacts/02_discovery/rank_input.filtered_out_ignored.csv`
- Canonical tracked-file input: `artifacts/02_discovery/rank_input.csv`

Canonical discovery counts:

| Metric | Count |
|---|---:|
| Tracked review rows | 185 |
| Shards | 37 |
| Max files per shard | 5 |
| Raw candidates | 27 |

Ignored local/generated tool caches excluded from tracked product-code coverage:

- `.agents/`
- `.claude-flow/`
- `.gitnexus/`
- `.serena/`
- `.mcp.json`

The tracked `doctor.config.json` file remained in scope.

## Discovery Subagent Prompt

No separate prompt transcript file was written by the subagent tool. This is the operational prompt template used for each file-review shard, reconstructed into this document from the scan orchestration state and the shard handoff instructions.

```text
You are a Codex Security file-review subagent for the IntelliGit repository-wide scan.

You own exactly one discovery shard:

- Repository root: <repo-root>
- Scan directory: <scan-dir>
- Threat model: artifacts/01_context/threat_model.md
- Handoff: artifacts/02_discovery/file_review_handoff.md
- Shard CSV: artifacts/02_discovery/subagent_shards/<SHARD>.csv
- Output JSON: artifacts/02_discovery/subagent_results/<SHARD>.json

Read the threat model, handoff, and every file listed in your shard CSV.
Review the full files for security-relevant behavior, especially privileged Git
operations, filesystem mutation, webview message handling, credential handling,
external process launch, repository discovery, build/release automation, and
localization workflows.

Do not edit repository source files.
Do not broaden scope beyond the assigned shard except for immediately necessary
supporting context.
For every assigned file, write a completion receipt with status, surface, and
evidence.

If you find a plausible issue, emit a pre-dedupe candidate object with:

- candidate_id
- title
- affected_locations
- instance_key
- attacker_controlled_source
- broken_control_or_sink
- impact
- closest_control
- why_plausible
- validation facts or explicit deferred validation reason
- attack_path facts or explicit deferred attack-path reason
- taxonomy

Validate the output JSON shape locally, preferably with jq.
Return only the shard output and concise completion status.
```

The parent agent owned orchestration, dedupe, cross-file validation, final severity decisions, and final report generation.

## Discovery Subagents

The scan used 37 shard workers. The shard CSVs are under:

`<scan-dir>/artifacts/02_discovery/subagent_shards/`

The shard results are under:

`<scan-dir>/artifacts/02_discovery/subagent_results/`

| Shard | Agent | Agent id | Candidate count |
|---|---|---|---:|
| shard_001 | Feynman | `019e993e-dc6d-75d3-b7cf-02399e586ed8` | 0 |
| shard_002 | Mencius | `019e993e-df40-78e0-9a5c-c5580b717195` | 0 |
| shard_003 | Halley | `019e993e-e333-77b3-8de2-5f11e23b7c3f` | 0 |
| shard_004 | Faraday | `019e993e-e61c-7300-8cd3-3547538871f6` | 0 |
| shard_005 | Carver | `019e993e-e976-7cb1-a7ed-2473e40be56a` | 0 |
| shard_006 | Hegel | `019e993e-ecec-7563-b1da-75ea64e1c077` | 0 |
| shard_007 | Lovelace | `019e9942-1cd9-7263-b362-051a28f9b1fe` | 1 |
| shard_008 | Mendel | `019e9942-c5e6-7163-9dbf-e225d9bb11fe` | 5 |
| shard_009 | Wegener | `019e9942-f15e-7de0-abe4-49b24979ef92` | 2 |
| shard_010 | Kepler | `019e9943-5ea8-7ea1-bcd4-cbb399daa248` | 1 |
| shard_011 | Descartes | `019e9943-86de-7a92-a526-96133ffe3604` | 2 |
| shard_012 | Ohm | `019e9943-acfd-7d20-92e3-c0e0b0913e5c` | 1 |
| shard_013 | Mill | `019e9946-a1e1-7a13-9d94-95ecc13c5474` | 3 |
| shard_014 | Carson | `019e9949-e50b-78a2-9f6f-31bbbbcdca82` | 2 |
| shard_015 | Franklin | `019e994a-10b7-7903-8527-5ef1c7d0f874` | 0 |
| shard_016 | Chandrasekhar | `019e994a-9aa1-7df1-ae51-84cba33cd49c` | 6 |
| shard_017 | Bohr | `019e994b-350e-70c1-81fd-aec97907691b` | 3 |
| shard_018 | Dewey | `019e994c-4be8-7712-b076-850b330413a3` | 0 |
| shard_019 | Copernicus | `019e994d-1984-7a00-a46c-6b9f31f2c813` | 0 |
| shard_020 | Hooke | `019e994d-e04d-7230-9e97-4cbb0e97d29c` | 0 |
| shard_021 | Archimedes | `019e994e-8a09-7c63-b9f2-2dec266e2a36` | 0 |
| shard_022 | Poincare | `019e9950-3c7d-7491-8c3c-0065fe282b80` | 0 |
| shard_023 | Bacon | `019e9953-70d2-7450-92ea-a463791e9282` | 0 |
| shard_024 | Pauli | `019e9953-ab95-7c53-8a74-32bb2341359c` | 0 |
| shard_025 | Turing | `019e9953-e52e-76a2-90f9-46ed2a434b65` | 0 |
| shard_026 | Sagan | `019e9954-2191-71c3-bcec-b69353109eb8` | 0 |
| shard_027 | Planck | `019e9954-5d21-7b43-815f-4c1aa0fb4603` | 0 |
| shard_028 | Goodall | `019e9954-b7b9-7203-915a-6924efa180e6` | 0 |
| shard_029 | Maxwell | `019e9956-2505-7252-8f20-b2da68aa44f2` | 0 |
| shard_030 | Avicenna | `019e9956-7743-7e30-8b76-dbdae8c5e5fd` | 0 |
| shard_031 | Meitner | `019e9956-ca21-75e3-a7c2-78c46e778c5e` | 1 |
| shard_032 | Schrodinger | `019e9957-1b6b-7853-97c1-3677c72f71eb` | 0 |
| shard_033 | Hypatia | `019e9957-7e71-7402-b892-7650398959f9` | 0 |
| shard_034 | James | `019e9957-becb-7a63-81e3-4523fb9c8b31` | 0 |
| shard_035 | Lorentz | `019e9958-b07c-74b3-a890-3c2d2c50e2ce` | 0 |
| shard_036 | Hume | `019e9959-ad75-77c3-8ece-02a12bfa9ff6` | 0 |
| shard_037 | Raman | `019e9959-fd53-7551-a99c-a5bade914ccb` | 0 |

## Shard Map

Each shard contained at most five tracked files. The full manifest is:

`<scan-dir>/artifacts/02_discovery/shard_manifest.json`

High-signal shards that produced candidates:

| Shard | Candidate count | Main files involved |
|---|---:|---|
| shard_007 | 1 | `scripts/localization-csv.js` |
| shard_008 | 5 | repository activation and repository mode surfaces |
| shard_009 | 2 | `src/commands/branchCommands.ts` and command surfaces |
| shard_010 | 1 | `src/git/operations.ts` |
| shard_011 | 2 | `src/git/parsers.ts`, `src/services/cloneService.ts` |
| shard_012 | 1 | `src/services/gitHelpers.ts`, `src/services/jetbrainsMergeService.ts` |
| shard_013 | 3 | `src/services/publishService.ts`, `src/services/repositoryDiscovery.ts` |
| shard_014 | 2 | `src/utils/fileOps.ts`, `src/utils/jetbrainsMergeTool.ts` |
| shard_016 | 6 | merge conflicts provider and commit panel actions |
| shard_017 | 3 | `src/views/panelFileActions.ts`, message validation |
| shard_031 | 1 | merge conflict session React UI |

## Phase 3: Reconciliation And Dedupe

The parent agent aggregated all shard output into:

- `artifacts/02_discovery/work_ledger.jsonl`
- `artifacts/02_discovery/raw_candidates.jsonl`

Then it deduped the 27 raw candidates into 10 groups:

| Group | Disposition track | Raw candidates | Summary |
|---|---|---|---|
| FIND-001 | validate | CAND-S009-1, CAND-S009-2, CAND-S012-1 | Option-like local branch refs reach Git without end-of-options protection |
| FIND-002 | validate | CAND-S010-1 | No-upstream push retry replays option-like remote names from Git config |
| FIND-003 | validate | CAND-S014-1 | Workspace configuration can launch a repository-controlled JetBrains merge tool executable |
| FIND-004 | validate | CAND-S008-1, CAND-S008-2, CAND-S008-3, CAND-S008-4, CAND-S008-5, CAND-S014-2, CAND-S016-1, CAND-S016-2, CAND-S016-3, CAND-S016-4, CAND-S016-5, CAND-S016-6, CAND-S017-1, CAND-S017-2, CAND-S017-3 | Git pathspec magic in file actions can mutate sibling files |
| FIND-005 | validate | CAND-S011-1 | GitLab clone flow can send a GitLab token to arbitrary HTTPS clone hosts |
| FIND-006 | validate | CAND-S011-2 | Commit log parser accepts record and field separators from commit subjects |
| FIND-007 | validate | CAND-S013-3 | Repository discovery can select a Git worktree outside the workspace |
| FIND-008 | validate | CAND-S031-1 | Merge conflict session trims paths before privileged actions |
| FIND-009 | validate | CAND-S007-1 | Localization CSV output does not neutralize spreadsheet formulas |
| SUPP-001 | validate for suppression | CAND-S013-1, CAND-S013-2 | Publish flow trusts provider-returned clone URLs from pinned provider APIs |

Dedupe artifact:

`<scan-dir>/artifacts/04_reconciliation/dedupe_report.md`

## Phase 4: Validation

Validation used a mix of static source tracing and disposable local Git repositories.

Validation rubric:

- Attacker-controlled source
- Broken control or sink
- Source-to-sink reachability
- Proportionate runtime proof
- Counterevidence or proof gaps

Validation closure artifact:

`<scan-dir>/artifacts/04_reconciliation/validation_report.md`

Shared PoC and probe logs:

| Artifact | Purpose |
|---|---|
| `_validation_shared/pathspec_magic_poc.log` | Proved Git pathspec magic remains active after `--` for multiple file actions |
| `_validation_shared/pathspec_clean_poc.log` | Proved `git clean -fd -- :(glob)*` removes matching siblings |
| `_validation_shared/branch_option_poc.log` | Proved option-like branch names can alter checkout semantics |
| `_validation_shared/rebase_exec_poc.log` | Proved option-like branch names can trigger `git rebase --exec` command execution |
| `_validation_shared/branch_option_remote_delivery_poc.log` | Checked remote delivery of option-like refs |
| `_validation_shared/branch_option_checkout_track_poc.log` | Counterevidence: normal `checkout --track` refused invalid local option-like branch names |
| `_validation_shared/push_suggestion_option_poc.log` | Proved Git can suggest option-like upstream push command from config |
| `_validation_shared/push_exact_replay_poc.log` | Checked extension-style push replay |
| `_validation_shared/push_exact_replay_with_config_poc.log` | Proved exact replay with config can execute through push option semantics |
| `_validation_shared/commit_separator_poc.log` | Proved commit log separator injection can create synthetic parsed rows |
| `_validation_shared/repository_discovery_outside_worktree_poc.log` | Proved worktree indirection can resolve outside workspace |
| `_validation_shared/jetbrains_relative_spawn_poc.log` | Proved relative executable path can run from repository root |
| `_validation_shared/merge_conflict_trim_poc.log` | Proved trimming paths can resolve the wrong conflict file |
| `_validation_shared/csv_formula_format_poc.log` | Proved CSV formatter leaves formula-leading cells unneutralized |

## Phase 5: Attack-Path Analysis

Attack-path analysis decided final reportability, severity, confidence, counterevidence, and remediation priority.

Attack-path artifacts:

- Scan-level closure: `<scan-dir>/artifacts/04_reconciliation/attack_path_report.md`
- Per-finding reports: `<scan-dir>/artifacts/05_findings/FIND-*/attack_path_report.md`

Final attack-path decisions:

| Group | Decision | Severity | Confidence |
|---|---|---|---|
| FIND-001 | report | high | high |
| FIND-002 | report | high | high |
| FIND-003 | report | high | high |
| FIND-004 | report | medium | high |
| FIND-005 | report | medium | medium |
| FIND-006 | report | medium | high |
| FIND-007 | report | medium | high |
| FIND-008 | report | medium | high |
| FIND-009 | report | low | high |
| SUPP-001 | ignore | none | high |

## Final Report Generation

Final report generation produced:

- `<scan-dir>/report.md`
- `<scan-dir>/report.html`
- `<scan-dir>/report_validation.md`

The Markdown report format was validated with:

```text
python3 <codex-security-plugin-dir>/scripts/validate_report_format.py --report-md <scan-dir>/report.md
```

Validation output:

```text
validated report format: <scan-dir>/report.md
```

The HTML report was rendered with:

```text
python3 <codex-security-plugin-dir>/scripts/render_report_html.py <scan-dir>/report.md <scan-dir>/report.html
```

## Closure Checks

Closure checks performed after final report generation:

| Check | Result |
|---|---|
| Tracked file receipts | 185 expected, 185 present |
| Missing tracked file receipts | 0 |
| Extra tracked file receipts | 0 |
| Raw candidate ledgers | 27 candidates had required receipts |
| Discovery phase receipts | Complete |
| Validation phase receipts | Complete |
| Attack-path phase receipts | Complete |
| Final Markdown report | Present |
| Final HTML report | Present |
| Report format validation | Passed |
| Repository source changes from scan | None |

Final repository hygiene:

- An early PoC temporarily set `.git/config` `core.worktree`.
- That local Git config value was removed with `git config --local --unset core.worktree`.
- A final `git status --short` check was clean.
- A final `git config --local --get core.worktree || true` check produced no configured worktree value.

## What Was Not Done

- The scan did not apply fixes to the repository.
- The scan did not commit or push anything.
- The scan did not run live credential capture against an HTTPS Git server for FIND-005; that finding remains medium confidence from static source trace.
- The scan did not treat ignored local tool caches as product runtime source files.
- The scan did not use GitNexus impact analysis because no source symbols were edited.

## Produced Review Comments

The final scan response emitted nine inline code-review directives, one for each reportable finding, targeting these files:

- `src/commands/branchCommands.ts`
- `src/git/operations.ts`
- `package.json`
- `src/services/cloneService.ts`
- `src/git/parsers.ts`
- `src/services/repositoryDiscovery.ts`
- `src/views/MergeConflictSessionPanel.ts`
- `scripts/localization-csv.js`

Those review comments were summaries of the final `report.md`; the canonical finding details remain in the scan artifacts.
