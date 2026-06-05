# IntelliGit Repository Threat Model

## Overview

IntelliGit is a VS Code extension that provides JetBrains-style Git workflows inside VS Code. Its primary runtime surfaces are the VS Code extension host, Git command orchestration, React webviews, repository discovery and activation, clone/publish flows, merge conflict tooling, and packaging/release automation.

The main assets are:

- The user's local repository contents, including uncommitted working-tree changes, commit history, branches, tags, stashes, remotes, and merge-conflict state.
- The user's filesystem under selected workspace and clone destination folders.
- Git remotes and credentials used to clone, push, publish, or fetch repositories.
- VS Code authentication sessions, VS Code SecretStorage entries, Git askpass environment values, and marketplace publishing secrets used in CI.
- The integrity of Git history-changing operations such as reset, rebase, amend, drop, cherry-pick, revert, checkout, delete, clean, and merge.
- The integrity of extension webviews and command/message boundaries between webview JavaScript and the privileged extension host.

The extension runs locally with the same privileges as the VS Code extension host. It is not a multi-tenant server application, but it handles attacker-influenced repository content, paths, branch names, remotes, commit messages, file contents, and webview messages. The highest-impact bugs are therefore local privilege or data-loss bugs, credential leaks, arbitrary command execution through Git/tool invocation, unsafe filesystem access outside the selected repository, unsafe webview-to-extension message handling, and unsafe remote/publish flows.

Primary product/runtime areas:

- `src/extension.ts` and `src/activation/*`: activation, repository-mode/no-repository-mode wiring, command registration, and UI event routing.
- `src/git/executor.ts`, `src/git/operations.ts`, `src/git/workingTree.ts`, `src/git/parsers.ts`, `src/git/stashFiles.ts`: Git process abstraction and Git output parsing.
- `src/commands/*`: branch, commit, file, history, and conflict operations that can mutate repository state.
- `src/services/cloneService.ts`, `src/services/publishService.ts`, `src/services/gitAskpass.ts`, `src/services/jetbrainsMergeService.ts`, `src/utils/jetbrainsMergeTool.ts`: clone/publish credential handling, provider API calls, Git askpass, and external merge tool execution.
- `src/views/*` and `src/webviews/*`: VS Code webview providers, HTML/CSP generation, message validation, and React UI.
- `scripts/*`, `.github/workflows/*`, and packaging scripts: build, validation, localization, and marketplace release automation.

## Threat Model, Trust Boundaries, and Assumptions

### Actors

- Normal local user: controls the VS Code workspace, repository, settings, clone URLs, branch names, commit messages, and UI selections.
- Repository/content attacker: can influence a repository the user opens or clones, including filenames, paths, symlinks, Git metadata, commit messages, branch/tag names, remotes, conflict contents, and file contents rendered in webviews.
- Remote provider attacker or compromised network/provider response: can influence GitHub/GitLab API responses, repository metadata, remote URLs, and clone/publish error payloads. HTTPS/TLS and VS Code/Git provider authentication are assumed to enforce transport security.
- Malicious webview script execution: would be possible only if the extension allows injection into its webview HTML or bundled scripts. If achieved, the attacker is across the webview-to-extension boundary and can send extension-host messages.
- Malicious local configuration/operator: can set extension settings, especially external JetBrains merge tool path. This actor is mostly out of scope as a user-controlled local configuration, but the extension should still avoid surprising command execution footguns.
- CI/release attacker: can influence repository workflow files, build scripts, or package contents in a contribution path, with possible impact on extension package integrity or release secrets if workflow permissions are too broad.

### Trust boundaries

- Webview JavaScript to extension host: webviews are untrusted relative to the extension host. Messages from webviews must be treated as attacker-controlled and validated before invoking Git, filesystem, or VS Code commands. Relevant controls include `src/views/messageValidation.ts`, protocol types under `src/webviews/protocol/*`, and per-provider `onDidReceiveMessage` handlers.
- Repository content to extension host: file paths, filenames, commit messages, branch names, remotes, stash metadata, conflict contents, Git output, and diff text can be attacker-controlled. Any path that crosses into filesystem or Git pathspec APIs must be normalized and constrained to repository-relative paths. `src/utils/fileOps.ts` is a key path validation control.
- Extension host to Git process: the extension invokes Git with structured arguments through `simple-git` and direct `execFile` in askpass flows. The extension must preserve argument boundaries and use `--` before path lists where applicable. It should avoid shell interpolation for untrusted values.
- Extension host to external tools: JetBrains merge tool invocation and VS Code commands cross into external process/editor behavior. Paths and executable settings are user/operator-controlled but still security-relevant because repository-supplied conflict paths must not become executable arguments outside intended semantics.
- Extension host to remote providers: clone/publish flows cross from local VS Code into GitHub/GitLab APIs and Git remotes. Tokens must not be written to persistent Git config, logs, command-line arguments, or files with broad permissions. `src/services/gitAskpass.ts` is the key transient credential control.
- VS Code SecretStorage/authentication to extension runtime: GitHub tokens come from VS Code Authentication API; GitLab tokens may be stored in SecretStorage. These tokens should be handled as secrets and only exposed to provider APIs or transient Git credential mechanisms.
- Build/release automation to marketplace secrets: `.github/workflows/publish.yml` can access publishing tokens. PRs or branch changes that alter workflow behavior, package contents, or versioning can affect release integrity.

### Assumptions

- VS Code extension isolation and webview CSP behave as documented by VS Code.
- The user's local Git binary and configured credential helpers are trusted infrastructure.
- GitHub/GitLab TLS endpoints and VS Code Authentication are trusted for token issuance and transport.
- The extension is installed by a user who expects local Git operations to mutate the selected repository; destructive Git operations are not inherently vulnerabilities when clearly confirmed and constrained to the intended repository.
- Tests, docs, localization catalogs, and examples are not primary runtime surfaces unless they feed build/package output, webview content, localization payloads, or CI/release behavior.

## Attack Surface, Mitigations, and Attacker Stories

### Git command execution and repository mutation

The extension runs Git commands for branch management, commit actions, staging, rollback, shelving, conflict resolution, clone, publish, and history editing. Attacker-controlled inputs include branch names, commit hashes, file paths, stash refs, remotes, and remote branch names.

Relevant mitigations:

- Git commands are generally passed as argument arrays through `GitExecutor`/`simple-git` rather than shell strings.
- File operations use path validation helpers such as `assertRepoRelativePath`.
- Many history-changing operations have modal confirmations and guardrails for pushed or merge commits.
- Some path operations use Git's `--` path separator.

Important attacker stories:

- A repository contains a malicious path such as `../outside`, absolute paths, paths with control characters, or unusual separators that are sent from a webview to the extension host and used for rollback, delete, diff, show, stage, checkout, or conflict accept. The security expectation is that it cannot escape the repository root or operate on unintended files.
- A repository contains branch, remote, or tag names that look like command-line flags or shell fragments. The security expectation is that they remain data arguments and cannot alter command structure beyond intended Git semantics.
- A webview sends a forged command message with an arbitrary file path, hash, or action. The extension must validate the message shape and authorization/invariant before mutating repository state.
- A malicious commit history or Git output attempts parser confusion that causes the extension to operate on the wrong commit, branch, or file.

### Webviews and message handling

React webviews render commit panels, commit graphs, commit info, merge editors, undocked views, and conflict sessions. They communicate with the extension host through `postMessage` and `onDidReceiveMessage`.

Relevant mitigations:

- `src/views/webviewHtml.ts` uses a strict CSP with `default-src 'none'`, nonce-based scripts, limited style/font/image sources, HTML escaping, and JSON `<` escaping.
- Bundled scripts and styles are loaded from extension resources via `asWebviewUri`.
- Message validation helpers enforce expected primitive types, path arrays, nullable strings, finite numbers, and Git hashes.

Important attacker stories:

- A commit message, branch name, file path, or diff content contains HTML/script payloads that are rendered in React UI or injected into shell HTML. The expected control is React escaping plus explicit escaping in `buildWebviewShellHtml`.
- A malicious webview message bypasses UI constraints and invokes privileged actions directly. The extension host must treat all webview messages as untrusted, independent of UI state.
- A CSP regression allows inline or remote script execution. If a webview XSS exists, the primary impact is abuse of the extension host message API rather than direct Node.js execution, but that message API can still mutate repositories.

### Clone, publish, credentials, and remotes

Clone and publish flows interact with GitHub/GitLab, user-provided SSH/HTTPS URLs, VS Code authentication, SecretStorage, and Git remotes. They may handle private repository URLs and tokens.

Relevant mitigations:

- GitHub auth uses VS Code Authentication API; GitLab token flow can use SecretStorage.
- HTTPS Git operations use a transient askpass directory and environment variables, and cleanup runs in `finally`.
- Publish flow checks existing `origin` before creating a provider repository, reducing orphaned repository and unintended remote risks.
- Clone URL inputs enforce basic provider-specific URL constraints for GitHub HTTPS and SSH modes.

Important attacker stories:

- A clone or publish token is embedded into `.git/config`, logs, terminal output, error messages, process arguments, or persistent files. The expected control is clean remote URLs plus transient askpass.
- A provider API response contains unexpected JSON shape, malicious URLs, or very large pagination. The extension should parse defensively, bound work, and avoid persisting unexpected remote URLs without user-visible context.
- A publish flow creates a remote repository before checking whether a local `origin` already exists, causing an orphaned repository or pushing to an unintended remote. This repository has an explicit remote-plan control that should remain intact.
- An attacker supplies a repository name or remote name with path separators, command flags, or control characters. The extension should validate provider names and remote names before Git operations.

### Filesystem and workspace boundaries

The extension opens, deletes, stages, rolls back, shelves, and diffs files inside the current repository. It also lets the user choose clone destinations and open folders.

Relevant mitigations:

- Repository-relative path validation rejects absolute paths, empty paths, repo root, control characters, and `..` traversal.
- Git operations should prefer repository roots discovered through Git and VS Code workspace APIs rather than trusting webview-supplied roots.

Important attacker stories:

- A path controlled by repository content or a forged webview message escapes the repository and deletes, shows, stages, or opens a sensitive local file.
- A symlink or Git path edge case causes a UI operation that appears repo-local to affect a different filesystem location.
- Clone destination plus repository name extraction creates a target path outside the chosen folder or collides with an existing sensitive directory.

### External merge tools and terminals

The extension can detect or launch JetBrains merge tools and can open an interactive rebase terminal.

Relevant mitigations:

- External tool paths are user settings or detected local application paths.
- Terminal commands should quote commit hashes or otherwise constrain inputs; Git hashes and parent expressions must be validated before terminal use.

Important attacker stories:

- A malicious file path, executable path, or conflict path becomes an argument injection vector into an external tool launch.
- An interactive rebase terminal command includes untrusted text that changes shell semantics. Validated hashes and quoting reduce risk.

### CI, release, and package integrity

The repository includes packaging and publishing automation. Marketplace release secrets are available to workflow jobs under configured conditions.

Relevant mitigations:

- Package/build scripts are explicit in `package.json`.
- Publish workflow uses version/status checks and marketplace tokens from GitHub Secrets.

Important attacker stories:

- A PR changes build scripts, workflow conditions, packaged files, or generated bundles to exfiltrate release tokens or publish a malicious extension.
- `.vscodeignore`, build output, or package manifest changes accidentally ship development artifacts, secrets, or unexpected scripts.
- Localization or generated webview payloads include unsafe runtime tokens or unescaped data that alter extension behavior.

## Severity Calibration (Critical, High, Medium, Low)

### Critical

Critical issues are those that plausibly allow arbitrary command execution, arbitrary filesystem write/delete outside the selected repository, release secret exfiltration, persistent credential leakage, or malicious extension publishing with minimal user interaction.

Examples:

- Webview-controlled path traversal reaches `vscode.workspace.fs.delete`, `git checkout`, `git clean`, or similar destructive operations outside the repository.
- A branch name, path, remote URL, or commit message reaches a shell command string and enables command injection.
- Clone/publish token handling writes tokens into `.git/config` or logs them in a way a repository/content attacker can reliably retrieve.
- CI workflow changes allow untrusted code to run with marketplace publish secrets.

### High

High issues cause unauthorized repository mutation, high-confidence credential exposure with user interaction, bypass of key history-operation guardrails, or cross-boundary webview abuse that reaches privileged extension commands.

Examples:

- Forged webview messages can reset, drop, amend, delete, or push commits without required validation or confirmation.
- Git ref/path parser confusion causes operations on the wrong branch, commit, stash, or file when opening a malicious repository.
- Provider publish flow can create or push to unintended remotes because existing remotes are not checked or validated.
- External merge tool invocation allows argument injection but requires a user-configured tool path or a conflict action.

### Medium

Medium issues cause bounded data exposure, denial of service, misleading UI that can induce unsafe user action, or security control erosion without direct arbitrary execution.

Examples:

- Unbounded parsing of very large Git output, diff output, or provider API pagination freezes the extension host.
- Error compaction exposes sensitive remote URLs or tokens in user-visible dialogs.
- CSP is weakened in a way that does not immediately enable script execution but increases XSS blast radius.
- Git output parsing incorrectly hides conflicts or failure state, making users believe a dangerous operation succeeded.

### Low

Low issues are hard-to-exploit robustness problems, developer-only weaknesses, or security hygiene gaps that do not cross a privileged boundary by themselves.

Examples:

- Test-only mocks accepting unsafe paths where production code validates them.
- Localization tooling accepts malformed reviewer strings that are later caught by validation before release.
- Non-secret metadata or benign command errors are shown more verbosely than ideal.
- Developer scripts have minor argument handling issues but are not run on attacker-controlled input in normal extension use.
