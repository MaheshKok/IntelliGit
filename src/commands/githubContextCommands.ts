import * as vscode from "vscode";
import * as path from "node:path";
import { resolveFileCommandContext } from "./fileContextCommands";
import {
    githubBlobUrl,
    githubCompareUrl,
    githubCloneUrl,
    githubGistUrl,
    githubIdentityFromRemote,
    githubIdentityFromName,
    githubRepositoryUrl,
    type GitHubIdentity,
} from "../git/githubUrls";
import type { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { isValidBranchName } from "../utils/gitRefs";
import { runRebaseCommand } from "./rebaseCommand";
import { runPublishGitHubProjectFlow } from "../services/publishService";

const REQUEST_TIMEOUT_MS = 30_000;

interface GitHubRemote {
    name: string;
    identity: GitHubIdentity;
}

/** Lists only credential-free, public GitHub identities from the captured Git repository. */
async function chooseGitHubRemote(
    gitOps: GitOps,
    repoRoot: string,
): Promise<GitHubRemote | undefined> {
    const names = (await gitOps.getRemotes()).sort((a, b) =>
        a === "origin" ? -1 : b === "origin" ? 1 : a.localeCompare(b),
    );
    const eligible: GitHubRemote[] = [];
    for (const name of names) {
        const url = await gitOps.getRemoteUrl(name);
        const identity = url && githubIdentityFromRemote(url);
        if (identity) eligible.push({ name, identity });
    }
    if (eligible.length === 0) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("No public GitHub remote is configured for this repository."),
        );
        return undefined;
    }
    if (eligible.length === 1) return eligible[0];
    const picked = await vscode.window.showQuickPick(
        eligible.map((remote) => ({
            label: remote.name,
            description: `${remote.identity.owner}/${remote.identity.repo}`,
            remote,
        })),
        {
            title: repoRoot,
            placeHolder: vscode.l10n.t("Select a GitHub remote"),
        },
    );
    return picked?.remote;
}

/** Opens the clicked repository's GitHub Pull Requests page. */
export async function viewGitHubPullRequestsFromContext(
    ctx: unknown,
    gitOps: GitOps,
): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Select a local file in a Git repository."),
            );
            return;
        }
        const remote = await chooseGitHubRemote(resolved.gitOps, resolved.repoRoot);
        if (!remote) return;
        await vscode.env.openExternal(
            vscode.Uri.parse(`${githubRepositoryUrl(remote.identity)}/pulls`),
        );
    } catch {
        await vscode.window.showErrorMessage(vscode.l10n.t("Unable to open GitHub Pull Requests."));
    }
}

/** Opens a published branch's compare page, honoring its upstream only on the chosen remote. */
export async function createGitHubPullRequestFromContext(
    ctx: unknown,
    gitOps: GitOps,
): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Select a local file in a Git repository."),
            );
            return;
        }
        const target = await resolved.gitOps.getMergeTarget();
        if (target.head === "(detached)" || target.oid === "(initial)") {
            await vscode.window.showErrorMessage(
                vscode.l10n.t(
                    "Create a commit on an attached branch before opening a pull request.",
                ),
            );
            return;
        }
        const remote = await chooseGitHubRemote(resolved.gitOps, resolved.repoRoot);
        if (!remote) return;
        const branches = await resolved.gitOps.getBranches();
        const upstream = branches.find(
            (branch) => !branch.isRemote && branch.name === target.head,
        )?.upstream;
        const remotePrefix = `${remote.name}/`;
        const publishedBranch = upstream?.startsWith(remotePrefix)
            ? upstream.slice(remotePrefix.length)
            : target.head;
        if (
            !branches.some(
                (branch) => branch.isRemote && branch.name === `${remote.name}/${publishedBranch}`,
            )
        ) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t(
                    "This branch is not published to the selected GitHub remote. Publish it before opening a pull request.",
                ),
            );
            return;
        }
        await vscode.env.openExternal(
            vscode.Uri.parse(githubCompareUrl(remote.identity, publishedBranch)),
        );
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Unable to open GitHub compare page: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}

/** Opens the clicked tracked file at its captured immutable commit. */
export async function viewGitHubFileFromContext(ctx: unknown, gitOps: GitOps): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Select a local file in a Git repository."),
            );
            return;
        }
        const target = await resolved.gitOps.getMergeTarget();
        if (target.oid === "(initial)") {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Commit this file before viewing it on GitHub."),
            );
            return;
        }
        if (!(await resolved.gitOps.hasFileAtHead(resolved.repoRelativePath))) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("The selected file is not tracked in HEAD."),
            );
            return;
        }
        const editor = vscode.window.activeTextEditor;
        let anchor: string | undefined;
        if (editor?.document.uri.toString() === resolved.selectedUri.toString()) {
            const start = editor.selection.start.line + 1;
            const last =
                editor.selection.end.line -
                (editor.selection.end.character === 0 && !editor.selection.isEmpty ? 1 : 0) +
                1;
            anchor = last > start ? `L${start}-L${last}` : `L${start}`;
        }
        const remote = await chooseGitHubRemote(resolved.gitOps, resolved.repoRoot);
        if (!remote) return;
        await vscode.env.openExternal(
            vscode.Uri.parse(
                githubBlobUrl(remote.identity, target.oid, resolved.repoRelativePath, anchor),
            ),
        );
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Unable to view the selected file on GitHub: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}

/** Delegates account management to VS Code's native Accounts UI. */
export async function manageGitHubAccounts(): Promise<void> {
    try {
        await vscode.commands.executeCommand("workbench.action.manageAccounts");
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Unable to open VS Code Accounts: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}

/** Publishes a confirmed snapshot of the clicked text document to GitHub Gist. */
export async function createGitHubGistFromContext(ctx: unknown, gitOps: GitOps): Promise<void> {
    let resolved;
    try {
        resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) throw new Error("Select a local text file.");
    } catch {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Select a readable local text file to create a Gist."),
        );
        return;
    }
    const editor = vscode.window.activeTextEditor;
    const selection =
        editor?.document.uri.toString() === resolved.selectedUri.toString() &&
        !editor.selection.isEmpty
            ? editor.selection
            : undefined;
    let snapshot: string;
    let dirty: boolean;
    try {
        const document = await vscode.workspace.openTextDocument(resolved.selectedUri);
        snapshot = document.getText(selection);
        dirty = document.isDirty;
    } catch {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("The selected file cannot be read as a text document."),
        );
        return;
    }
    const fileName = path.basename(resolved.selectedUri.fsPath);
    const description = await vscode.window.showInputBox({
        title: vscode.l10n.t("Create Gist"),
        prompt: vscode.l10n.t("Gist description"),
        value: fileName,
    });
    if (description === undefined) return;
    const visibility = await vscode.window.showQuickPick(
        [
            { label: vscode.l10n.t("Secret"), value: false },
            { label: vscode.l10n.t("Public"), value: true },
        ],
        { placeHolder: vscode.l10n.t("Choose Gist visibility (Secret is the default)") },
    );
    if (!visibility) return;
    const action = vscode.l10n.t("Create Gist");
    const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t("Publish {source} from {file} as a {visibility} Gist{dirty}?", {
            source: selection
                ? vscode.l10n.t("selected text")
                : vscode.l10n.t("the whole document"),
            file: fileName,
            visibility: visibility.label,
            dirty: dirty ? vscode.l10n.t(" (dirty buffer)") : "",
        }),
        { modal: true },
        action,
    );
    if (confirmed !== action) return;
    try {
        const session = await vscode.authentication.getSession("github", ["gist"], {
            createIfNone: true,
        });
        if (!session) return;
        const response = await fetch("https://api.github.com/gists", {
            method: "POST",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                Authorization: `Bearer ${session.accessToken}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "IntelliGit",
            },
            body: JSON.stringify({
                description,
                public: visibility.value,
                files: { [fileName]: { content: snapshot } },
            }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: unknown = await response.json();
        const url =
            payload &&
            typeof payload === "object" &&
            "html_url" in payload &&
            typeof payload.html_url === "string"
                ? githubGistUrl(payload.html_url)
                : null;
        if (!url) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("GitHub returned an unsafe Gist URL; it was not opened."),
            );
            return;
        }
        const openAction = vscode.l10n.t("Open Gist");
        const choice = await vscode.window.showInformationMessage(
            vscode.l10n.t("Gist created: {url}", { url }),
            openAction,
        );
        if (choice === openAction) await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch {
        await vscode.window.showErrorMessage(
            vscode.l10n.t(
                "Unable to publish the Gist to GitHub. Check authentication and try again.",
            ),
        );
    }
}

/** Loads the captured origin's fork parent from the fixed GitHub API host. */
async function loadForkParent(
    origin: GitHubIdentity,
): Promise<{ parentName: GitHubIdentity; defaultBranch: string } | null> {
    const session = await vscode.authentication.getSession("github", ["repo"], {
        createIfNone: true,
    });
    if (!session) return null;
    const response = await fetch(`https://api.github.com/repos/${origin.owner}/${origin.repo}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "IntelliGit",
        },
    });
    if (!response.ok) throw new Error(`GitHub metadata request failed (HTTP ${response.status}).`);
    const metadata: unknown = await response.json();
    if (
        !metadata ||
        typeof metadata !== "object" ||
        !("fork" in metadata) ||
        metadata.fork !== true ||
        !("parent" in metadata)
    ) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("The origin repository is not an accessible GitHub fork."),
        );
        return null;
    }
    const parent = metadata.parent;
    const originName =
        "full_name" in metadata && typeof metadata.full_name === "string"
            ? githubIdentityFromName(metadata.full_name)
            : null;
    const parentName =
        parent &&
        typeof parent === "object" &&
        "full_name" in parent &&
        typeof parent.full_name === "string"
            ? githubIdentityFromName(parent.full_name)
            : null;
    const defaultBranch =
        parent &&
        typeof parent === "object" &&
        "default_branch" in parent &&
        typeof parent.default_branch === "string"
            ? parent.default_branch
            : "";
    if (
        !originName ||
        originName.owner.toLowerCase() !== origin.owner.toLowerCase() ||
        originName.repo.toLowerCase() !== origin.repo.toLowerCase() ||
        !parentName ||
        !isValidBranchName(defaultBranch)
    ) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("GitHub returned invalid fork parent or default-branch metadata."),
        );
        return null;
    }
    return { parentName, defaultBranch };
}

/** Syncs only the clicked fork after validating its confirmed Git state. */
export async function syncGitHubForkFromContext(
    ctx: unknown,
    gitOps: GitOps,
    callbacks: {
        refresh: (repoRoot: string) => Promise<void>;
        refreshConflicts: (repoRoot: string) => Promise<void>;
        openConflictSession: (gitOps: GitOps, repoRoot: string) => Promise<void>;
    } = {
        refresh: () => Promise.resolve(),
        refreshConflicts: () => Promise.resolve(),
        openConflictSession: () => Promise.resolve(),
    },
): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Select a local file in a Git repository."),
            );
            return;
        }
        const scoped = resolved.gitOps;
        const originUrl = await scoped.getRemoteUrl("origin");
        const origin = originUrl && githubIdentityFromRemote(originUrl);
        if (!origin) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Sync Fork requires a public GitHub origin remote."),
            );
            return;
        }
        const target = await scoped.getMergeTarget();
        if (target.head === "(detached)" || target.oid === "(initial)") {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Sync Fork requires an attached branch with a commit."),
            );
            return;
        }
        if (
            (await scoped.hasUncommittedChanges()) ||
            (await scoped.getActiveOperation()) !== "none"
        ) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t(
                    "Finish the current Git operation and commit or stash changes before syncing this fork.",
                ),
            );
            return;
        }
        const upstreamUrl = await scoped.getRemoteUrl("upstream");
        const fork = await loadForkParent(origin);
        if (!fork) return;
        const { parentName, defaultBranch } = fork;
        if (upstreamUrl) {
            const upstream = githubIdentityFromRemote(upstreamUrl);
            if (
                !upstream ||
                upstream.owner.toLowerCase() !== parentName.owner.toLowerCase() ||
                upstream.repo.toLowerCase() !== parentName.repo.toLowerCase()
            ) {
                await vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "The existing upstream remote does not match this fork's GitHub parent.",
                    ),
                );
                return;
            }
        }
        const action = vscode.l10n.t("Sync Fork");
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                "Sync {repository} branch {branch} with {parent}/{defaultBranch}{upstreamChange}?",
                {
                    repository: resolved.repoRoot,
                    branch: target.head,
                    parent: `${parentName.owner}/${parentName.repo}`,
                    defaultBranch,
                    upstreamChange: upstreamUrl ? "" : vscode.l10n.t(" and add upstream"),
                },
            ),
            { modal: true },
            action,
        );
        if (confirm !== action) return;
        const unchanged = async (expectedUpstream: string | null): Promise<boolean> => {
            const current = await scoped.getMergeTarget();
            const same =
                current.head === target.head &&
                current.oid === target.oid &&
                !(await scoped.hasUncommittedChanges()) &&
                (await scoped.getActiveOperation()) === "none" &&
                (await scoped.getRemoteUrl("origin")) === originUrl &&
                (await scoped.getRemoteUrl("upstream")) === expectedUpstream;
            if (!same)
                await vscode.window.showErrorMessage(
                    vscode.l10n.t("The repository changed while syncing. Run Sync Fork again."),
                );
            return same;
        };
        if (!(await unchanged(upstreamUrl))) return;
        let expectedUpstream = upstreamUrl;
        if (!expectedUpstream) {
            await scoped.addRemote("upstream", githubCloneUrl(parentName));
            expectedUpstream = await scoped.getRemoteUrl("upstream");
            const effective = expectedUpstream && githubIdentityFromRemote(expectedUpstream);
            if (
                !effective ||
                effective.owner.toLowerCase() !== parentName.owner.toLowerCase() ||
                effective.repo.toLowerCase() !== parentName.repo.toLowerCase()
            ) {
                await vscode.window.showErrorMessage(
                    vscode.l10n.t(
                        "The existing upstream remote does not match this fork's GitHub parent.",
                    ),
                );
                return;
            }
        }
        let fetchedOid: string;
        try {
            fetchedOid = await scoped.fetchRemoteBranch("upstream", defaultBranch);
        } catch (error) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Fork fetch failed; upstream may have been added: {message}", {
                    message: getErrorMessage(error),
                }),
            );
            return;
        }
        if (!(await unchanged(expectedUpstream))) return;
        await runRebaseCommand(fetchedOid, scoped, {
            currentBranch: target.head,
            rebase: () => scoped.rebase(fetchedOid),
            refresh: () => callbacks.refresh(resolved.repoRoot),
            refreshConflicts: () => callbacks.refreshConflicts(resolved.repoRoot),
            openConflictSession: () => callbacks.openConflictSession(scoped, resolved.repoRoot),
            beforeRebase: () => unchanged(expectedUpstream),
        });
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Sync Fork failed: {message}", { message: getErrorMessage(error) }),
        );
    }
}

/** Shares the branch of the clicked repository through the GitHub-only publish path. */
export async function shareGitHubProjectFromContext(ctx: unknown, gitOps: GitOps): Promise<void> {
    try {
        const resolved = await resolveFileCommandContext(ctx, gitOps);
        if (!resolved) {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Select a local file in a Git repository."),
            );
            return;
        }
        const target = await resolved.gitOps.getMergeTarget();
        if (target.head === "(detached)" || target.oid === "(initial)") {
            await vscode.window.showErrorMessage(
                vscode.l10n.t("Commit on an attached branch before sharing this project."),
            );
            return;
        }
        await runPublishGitHubProjectFlow(resolved.gitOps, target.head, resolved.repoRoot);
    } catch (error) {
        await vscode.window.showErrorMessage(
            vscode.l10n.t("Unable to share the selected project: {message}", {
                message: getErrorMessage(error),
            }),
        );
    }
}
