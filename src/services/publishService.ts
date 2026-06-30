import * as vscode from "vscode";
import * as https from "https";
import * as path from "path";
import { GitOps } from "../git/operations";
import { getErrorMessage } from "../utils/errors";
import { runGitCommandWithAskpass } from "./gitAskpass";
import { showTimedInformationMessage, showTimedWarningMessage } from "../utils/notifications";
import { isValidBranchName } from "../utils/gitRefs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PublishProvider = "github" | "gitlab" | "bitbucket-cloud" | "bitbucket-server";
const REQUEST_TIMEOUT_MS = 30_000;

interface CreatedRepo {
    cloneUrl: string;
    sshUrl: string;
    htmlUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

interface PublishAuth {
    token: string;
    /** GitLab uses "oauth2" as the username; GitHub uses x-access-token. */
    gitUsername: string;
}

type RemotePlan =
    | { kind: "existing"; remoteName: string; remoteBranchName?: string }
    | { kind: "create"; remoteName: string; remoteBranchName?: string };

interface RemoteChoice extends vscode.QuickPickItem {
    action: "existing" | "create";
}

type PublishTarget =
    | { provider: "github" | "gitlab" }
    | { provider: "bitbucket-cloud"; workspace: string }
    | { provider: "bitbucket-server"; baseUrl: string; projectKey: string };

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Publishes the current branch to an existing remote or a newly created provider repository.
 *
 * The flow prompts before creating provider resources, stores provider tokens in SecretStorage,
 * pushes with upstream tracking through GitOps, and reports recoverable provider/Git failures to
 * the user instead of throwing them past the command handler.
 */
export async function runPublishBranchFlow(
    gitOps: GitOps,
    branchName: string,
    repoRoot: string,
    secrets?: vscode.SecretStorage,
): Promise<void> {
    // 1. Resolve remote strategy before any provider repository is created.
    const remotes = await gitOps.getRemotes();
    const remotePlan = await pickRemotePlan(remotes, branchName);
    if (!remotePlan) return;

    let remoteBranchName = remotePlan.remoteBranchName ?? branchName;
    if (remotePlan.kind === "existing") {
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: vscode.l10n.t("Pushing to {remote}...", {
                        remote: remotePlan.remoteName,
                    }),
                    cancellable: false,
                },
                async () => {
                    await gitOps.pushWithUpstream(
                        remotePlan.remoteName,
                        branchName,
                        remoteBranchName,
                    );
                },
            );
            showTimedInformationMessage(
                vscode.l10n.t('Branch "{branch}" published to {remote}.', {
                    branch: remoteBranchName,
                    remote: remotePlan.remoteName,
                }),
            );
        } catch (err) {
            vscode.window.showErrorMessage(
                vscode.l10n.t("Failed to publish branch: {message}", {
                    message: getErrorMessage(err),
                }),
            );
        }
        return;
    }

    // 2. Provider
    const provider = await pickPublishProvider();
    if (!provider) return;

    // 3. Visibility
    const visibility = await pickVisibility();
    if (!visibility) return;

    // 4. Repo name
    const defaultName = path.basename(repoRoot);
    const repoName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Repository name"),
        value: defaultName,
        validateInput: (value) => {
            if (!value.trim()) return vscode.l10n.t("Name is required");
            if (/[^a-zA-Z0-9._-]/.test(value))
                return vscode.l10n.t("Only letters, digits, ., -, _ are allowed");
            return undefined;
        },
    });
    if (!repoName) return;

    const target = await pickPublishTarget(provider);
    if (!target) return;

    // 5. Published branch name is the last user input before auth and provider writes.
    if (!remotePlan.remoteBranchName) {
        const publishedBranchName = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("Published branch name"),
            value: remoteBranchName,
            validateInput: (value) => {
                const trimmed = value.trim();
                if (!trimmed) return vscode.l10n.t("Branch name is required");
                if (!isValidBranchName(trimmed)) {
                    return vscode.l10n.t("Invalid branch name '{branch}'.", { branch: value });
                }
                return undefined;
            },
        });
        if (!publishedBranchName) return;
        remoteBranchName = publishedBranchName.trim();
    }

    // 6. Authenticate
    const auth = await acquireAuth(provider, secrets);
    if (!auth) return;

    // 7. Create the remote repository via provider API.
    let created: CreatedRepo;
    try {
        created = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t("Creating repository on {provider}...", {
                    provider: providerLabel(provider),
                }),
                cancellable: false,
            },
            async () => {
                if (provider === "github") {
                    return createGitHubRepo(auth.token, repoName, visibility);
                }
                if (provider === "gitlab") {
                    return createGitLabRepo(auth.token, repoName, visibility);
                }
                if (target.provider === "bitbucket-cloud") {
                    return createBitbucketCloudRepo(auth, target.workspace, repoName, visibility);
                }
                if (target.provider === "bitbucket-server") {
                    return createBitbucketServerRepo(
                        auth,
                        target.baseUrl,
                        target.projectKey,
                        repoName,
                        visibility,
                    );
                }
                throw new Error("Unsupported publish provider");
            },
        );
    } catch (err) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Failed to create repository: {message}", {
                message: getErrorMessage(err),
            }),
        );
        return;
    }

    // 8. Add clean remote URL and push with transient askpass credentials.
    let remoteAdded = false;
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t("Pushing to {remote}...", {
                    remote: remotePlan.remoteName,
                }),
                cancellable: false,
            },
            async () => {
                await gitOps.addRemote(remotePlan.remoteName, created.cloneUrl);
                remoteAdded = true;
                await runGitPushWithAskpass(
                    repoRoot,
                    remotePlan.remoteName,
                    branchName,
                    remoteBranchName,
                    {
                        username: auth.gitUsername,
                        token: auth.token,
                    },
                );
            },
        );

        const openRepositoryAction = vscode.l10n.t("Open Repository");
        const openChoice = await vscode.window.showInformationMessage(
            vscode.l10n.t('Branch "{branch}" published to {url}', {
                branch: remoteBranchName,
                url: created.htmlUrl,
            }),
            openRepositoryAction,
        );
        if (openChoice === openRepositoryAction) {
            await vscode.env.openExternal(vscode.Uri.parse(created.htmlUrl));
        }
    } catch (err) {
        if (remoteAdded) {
            await gitOps.removeRemote(remotePlan.remoteName).catch(() => undefined);
        }
        const message = getErrorMessage(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t("Failed to publish branch: {message}", { message }),
        );
    }
}

function parseRemoteRefInput(
    value: string,
    fallbackBranch: string,
): { remoteName: string; remoteBranchName: string } {
    const trimmed = value.trim();
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex <= 0) {
        return { remoteName: trimmed, remoteBranchName: fallbackBranch };
    }
    return {
        remoteName: trimmed.slice(0, slashIndex),
        remoteBranchName: trimmed.slice(slashIndex + 1) || fallbackBranch,
    };
}

async function pickRemotePlan(
    remotes: string[],
    branchName: string,
): Promise<RemotePlan | undefined> {
    if (remotes.includes("origin")) {
        const quickPick = vscode.window.createQuickPick<RemoteChoice>();
        quickPick.items = [
            {
                label: vscode.l10n.t('$(git-branch) Push to Existing "origin"'),
                description: vscode.l10n.t(
                    "Use the current origin remote without creating a new repository",
                ),
                action: "existing" as const,
                alwaysShow: true,
            },
            {
                label: vscode.l10n.t("$(add) Use a Different Remote Name"),
                description: vscode.l10n.t("Add the new repository as a separate remote"),
                action: "create" as const,
                alwaysShow: true,
            },
        ];
        quickPick.placeholder = vscode.l10n.t(
            'Remote "origin" already exists. How do you want to proceed?',
        );
        quickPick.value = `origin/${branchName}`;
        const choice = await new Promise<RemotePlan | undefined>((resolve) => {
            const disposables: vscode.Disposable[] = [];
            let settled = false;
            const finish = (plan: RemotePlan | undefined): void => {
                if (settled) return;
                settled = true;
                for (const disposable of disposables) {
                    disposable.dispose();
                }
                quickPick.dispose();
                resolve(plan);
            };
            disposables.push(
                quickPick.onDidAccept(() => {
                    const selected = quickPick.selectedItems[0];
                    if (!selected) return;
                    if (selected.action === "existing") {
                        const { remoteBranchName } = parseRemoteRefInput(
                            quickPick.value,
                            branchName,
                        );
                        finish({
                            kind: "existing",
                            remoteName: "origin",
                            remoteBranchName,
                        });
                        return;
                    }

                    const parsed = parseRemoteRefInput(quickPick.value, branchName);
                    if (!parsed.remoteName) {
                        void vscode.window.showErrorMessage(vscode.l10n.t("Name is required"));
                        return;
                    }
                    if (remotes.includes(parsed.remoteName)) {
                        void vscode.window.showErrorMessage(
                            vscode.l10n.t('Remote "{remote}" already exists', {
                                remote: parsed.remoteName,
                            }),
                        );
                        return;
                    }
                    if (/[^a-zA-Z0-9._-]/.test(parsed.remoteName)) {
                        void vscode.window.showErrorMessage(
                            vscode.l10n.t("Only letters, digits, ., -, _ are allowed"),
                        );
                        return;
                    }
                    if (!isValidBranchName(parsed.remoteBranchName)) {
                        void vscode.window.showErrorMessage(
                            vscode.l10n.t("Invalid branch name '{branch}'.", {
                                branch: parsed.remoteBranchName,
                            }),
                        );
                        return;
                    }
                    finish({
                        kind: "create",
                        remoteName: parsed.remoteName,
                        remoteBranchName: parsed.remoteBranchName,
                    });
                }),
                quickPick.onDidHide(() => finish(undefined)),
            );
            quickPick.show();
        });
        if (!choice) return;
        return choice;
    }

    return { kind: "create", remoteName: "origin" };
}

// ---------------------------------------------------------------------------
// Auth acquisition
// ---------------------------------------------------------------------------

async function acquireAuth(
    provider: PublishProvider,
    secrets?: vscode.SecretStorage,
): Promise<PublishAuth | undefined> {
    if (provider === "github") {
        const session = await acquireGitHubSession();
        if (!session) return undefined;
        return {
            token: session.accessToken,
            gitUsername: "x-access-token",
        };
    }

    if (provider === "gitlab") {
        const token = await getGitLabToken(secrets);
        if (!token) return undefined;
        return {
            token,
            gitUsername: "oauth2",
        };
    }

    return getBitbucketAuth(provider);
}

async function getBitbucketAuth(
    provider: Extract<PublishProvider, "bitbucket-cloud" | "bitbucket-server">,
): Promise<PublishAuth | undefined> {
    const label = providerLabel(provider);
    const username = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("{provider} username", { provider: label }),
        validateInput: (value) => {
            if (!value.trim()) return vscode.l10n.t("Username is required");
            return undefined;
        },
    });
    if (!username) return undefined;

    const token = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("{provider} app password or access token", { provider: label }),
        password: true,
        validateInput: (value) => {
            if (!value.trim()) return vscode.l10n.t("Token is required");
            return undefined;
        },
    });
    if (!token) return undefined;
    return {
        token: token.trim(),
        gitUsername: username.trim(),
    };
}

// ---------------------------------------------------------------------------
// Provider + visibility pickers
// ---------------------------------------------------------------------------

async function pickPublishProvider(): Promise<PublishProvider | undefined> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: vscode.l10n.t("$(github) GitHub"),
                description: vscode.l10n.t("Create a repository on GitHub and push"),
                provider: "github" as const,
            },
            {
                label: vscode.l10n.t("$(gitlab) GitLab"),
                description: vscode.l10n.t("Create a project on GitLab and push"),
                provider: "gitlab" as const,
            },
            {
                label: vscode.l10n.t("$(cloud) Bitbucket Cloud"),
                description: vscode.l10n.t("Create a repository on Bitbucket Cloud and push"),
                provider: "bitbucket-cloud" as const,
            },
            {
                label: vscode.l10n.t("$(server) Bitbucket Server"),
                description: vscode.l10n.t(
                    "Create a repository on Bitbucket Server or Data Center and push",
                ),
                provider: "bitbucket-server" as const,
            },
        ],
        { placeHolder: vscode.l10n.t("Where do you want to publish this branch?") },
    );
    return picked?.provider;
}

async function pickPublishTarget(provider: PublishProvider): Promise<PublishTarget | undefined> {
    if (provider === "github" || provider === "gitlab") return { provider };
    if (provider === "bitbucket-cloud") {
        const workspace = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("Bitbucket workspace"),
            validateInput: (value) => {
                if (!value.trim()) return vscode.l10n.t("Workspace is required");
                return undefined;
            },
        });
        return workspace ? { provider, workspace: workspace.trim() } : undefined;
    }

    const baseUrl = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Bitbucket Server URL"),
        placeHolder: "https://bitbucket.example.com",
        validateInput: (value) => validateHttpBaseUrl(value) ?? undefined,
    });
    if (!baseUrl) return undefined;
    const projectKey = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Bitbucket project key"),
        validateInput: (value) => {
            if (!value.trim()) return vscode.l10n.t("Project key is required");
            return undefined;
        },
    });
    return projectKey
        ? { provider, baseUrl: normalizeHttpBaseUrl(baseUrl), projectKey: projectKey.trim() }
        : undefined;
}

async function pickVisibility(): Promise<"private" | "public" | undefined> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: vscode.l10n.t("$(lock) Private"),
                description: vscode.l10n.t("Only you and collaborators can see this repository"),
                value: "private" as const,
            },
            {
                label: vscode.l10n.t("$(globe) Public"),
                description: vscode.l10n.t("Anyone on the internet can see this repository"),
                value: "public" as const,
            },
        ],
        { placeHolder: vscode.l10n.t("Choose repository visibility") },
    );
    return picked?.value;
}

function providerLabel(provider: PublishProvider): string {
    switch (provider) {
        case "github":
            return "GitHub";
        case "gitlab":
            return "GitLab";
        case "bitbucket-cloud":
            return "Bitbucket Cloud";
        case "bitbucket-server":
            return "Bitbucket Server";
    }
}

// ---------------------------------------------------------------------------
// GitHub: auth + API
// ---------------------------------------------------------------------------

async function acquireGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
    try {
        return await vscode.authentication.getSession("github", ["repo"], {
            createIfNone: true,
        });
    } catch (err) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("GitHub authentication failed: {message}", {
                message: getErrorMessage(err),
            }),
        );
        return undefined;
    }
}

async function createGitHubRepo(
    token: string,
    name: string,
    visibility: "private" | "public",
): Promise<CreatedRepo> {
    const body = JSON.stringify({
        name,
        private: visibility === "private",
        auto_init: false,
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };
        const succeed = (repo: CreatedRepo): void => {
            if (settled) return;
            settled = true;
            resolve(repo);
        };
        const req = https.request(
            "https://api.github.com/user/repos",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "User-Agent": "vscode-intelligit",
                    Accept: "application/vnd.github.v3+json",
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => (data += chunk.toString()));
                res.on("end", () => {
                    req.setTimeout(0);
                    if (settled) return;
                    if (res.statusCode === 201) {
                        try {
                            const repo = parseJsonObject(data);
                            const cloneUrl = repo ? readString(repo, "clone_url") : undefined;
                            const sshUrl = repo ? readString(repo, "ssh_url") : undefined;
                            const htmlUrl = repo ? readString(repo, "html_url") : undefined;
                            if (!cloneUrl || !sshUrl || !htmlUrl) {
                                fail("Invalid GitHub API response");
                                return;
                            }
                            succeed({
                                cloneUrl,
                                sshUrl,
                                htmlUrl,
                            });
                        } catch {
                            fail("Invalid GitHub API response");
                        }
                    } else {
                        const msg = tryExtractApiError(data);
                        fail(msg || `GitHub API returned ${res.statusCode}`);
                    }
                });
            },
        );
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            fail("Request timed out while creating repository");
        });
        req.on("error", (err) => {
            req.setTimeout(0);
            fail(getErrorMessage(err));
        });
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// GitLab: token + API
// ---------------------------------------------------------------------------

const GITLAB_TOKEN_KEY = "intelligit.gitlab.personalAccessToken";

async function getGitLabToken(secrets?: vscode.SecretStorage): Promise<string | undefined> {
    if (secrets) {
        try {
            const stored = await secrets.get(GITLAB_TOKEN_KEY);
            if (stored) return stored;
        } catch {
            // fall through
        }
    }

    const config = vscode.workspace.getConfiguration("intelligit");
    const legacy = config.get<string>("gitlab.personalAccessToken") || "";
    if (legacy) {
        if (secrets) {
            try {
                await secrets.store(GITLAB_TOKEN_KEY, legacy);
                await config.update("gitlab.personalAccessToken", undefined, true);
            } catch {
                // migration failed — still use legacy value
            }
        }
        return legacy;
    }

    const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t(
            "Enter your GitLab Personal Access Token (requires api scope to create projects)",
        ),
        placeHolder: "glpat-...",
        password: true,
        validateInput: (value) => {
            if (!value.trim()) return vscode.l10n.t("Token is required");
            return undefined;
        },
    });
    if (!input) return undefined;

    if (secrets) {
        const saveAction = vscode.l10n.t("Save");
        const dontSaveAction = vscode.l10n.t("Don't Save");
        const save = await vscode.window.showInformationMessage(
            vscode.l10n.t("Save this token for future use?"),
            saveAction,
            dontSaveAction,
        );
        if (save === saveAction) {
            try {
                await secrets.store(GITLAB_TOKEN_KEY, input);
            } catch {
                showTimedWarningMessage(vscode.l10n.t("Could not save token securely."));
            }
        }
    }

    return input;
}

async function createGitLabRepo(
    token: string,
    name: string,
    visibility: "private" | "public",
): Promise<CreatedRepo> {
    const body = new URLSearchParams({
        name,
        visibility,
    }).toString();

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };
        const succeed = (repo: CreatedRepo): void => {
            if (settled) return;
            settled = true;
            resolve(repo);
        };
        const req = https.request(
            "https://gitlab.com/api/v4/projects",
            {
                method: "POST",
                headers: {
                    "PRIVATE-TOKEN": token,
                    "User-Agent": "vscode-intelligit",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => (data += chunk.toString()));
                res.on("end", () => {
                    req.setTimeout(0);
                    if (settled) return;
                    if (res.statusCode === 201) {
                        try {
                            const project = parseJsonObject(data);
                            const webUrl = project ? readString(project, "web_url") : undefined;
                            const cloneUrl =
                                (project ? readString(project, "http_url_to_repo") : undefined) ??
                                (webUrl ? `${webUrl}.git` : undefined);
                            const sshUrl =
                                (project ? readString(project, "ssh_url_to_repo") : undefined) ??
                                "";
                            if (!cloneUrl || !webUrl) {
                                fail("Invalid GitLab API response");
                                return;
                            }
                            succeed({
                                cloneUrl,
                                sshUrl,
                                htmlUrl: webUrl,
                            });
                        } catch {
                            fail("Invalid GitLab API response");
                        }
                    } else {
                        const msg = tryExtractApiError(data);
                        fail(msg || `GitLab API returned ${res.statusCode}`);
                    }
                });
            },
        );
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            fail("Request timed out while creating repository");
        });
        req.on("error", (err) => {
            req.setTimeout(0);
            fail(getErrorMessage(err));
        });
        req.write(body);
        req.end();
    });
}

async function createBitbucketCloudRepo(
    auth: PublishAuth,
    workspace: string,
    name: string,
    visibility: "private" | "public",
): Promise<CreatedRepo> {
    const body = JSON.stringify({
        name,
        scm: "git",
        is_private: visibility === "private",
    });
    const encodedWorkspace = encodeURIComponent(workspace);
    const encodedName = encodeURIComponent(name);

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };
        const succeed = (repo: CreatedRepo): void => {
            if (settled) return;
            settled = true;
            resolve(repo);
        };
        const req = https.request(
            `https://api.bitbucket.org/2.0/repositories/${encodedWorkspace}/${encodedName}`,
            {
                method: "POST",
                headers: {
                    Authorization: basicAuthHeader(auth),
                    "User-Agent": "vscode-intelligit",
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("error", (err) => {
                    req.setTimeout(0);
                    fail(getErrorMessage(err));
                });
                res.on("aborted", () => {
                    req.setTimeout(0);
                    fail("Response aborted while creating repository");
                });
                res.on("data", (chunk: Buffer) => (data += chunk.toString()));
                res.on("end", () => {
                    req.setTimeout(0);
                    if (settled) return;
                    if (res.statusCode === 200 || res.statusCode === 201) {
                        try {
                            const repo = parseJsonObject(data);
                            const cloneUrl = repo ? readCloneLink(repo) : undefined;
                            const htmlUrl = repo ? readLinkHref(repo, "html") : undefined;
                            if (!cloneUrl || !htmlUrl) {
                                fail("Invalid Bitbucket Cloud API response");
                                return;
                            }
                            succeed({ cloneUrl, sshUrl: "", htmlUrl });
                        } catch {
                            fail("Invalid Bitbucket Cloud API response");
                        }
                    } else {
                        const msg = tryExtractApiError(data);
                        fail(msg || `Bitbucket Cloud API returned ${res.statusCode}`);
                    }
                });
            },
        );
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            fail("Request timed out while creating repository");
        });
        req.on("error", (err) => {
            req.setTimeout(0);
            fail(getErrorMessage(err));
        });
        req.write(body);
        req.end();
    });
}

async function createBitbucketServerRepo(
    auth: PublishAuth,
    baseUrl: string,
    projectKey: string,
    name: string,
    visibility: "private" | "public",
): Promise<CreatedRepo> {
    const body = JSON.stringify({
        name,
        scmId: "git",
        forkable: true,
        public: visibility === "public",
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message: string): void => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };
        const succeed = (repo: CreatedRepo): void => {
            if (settled) return;
            settled = true;
            resolve(repo);
        };
        const req = https.request(
            `${baseUrl}/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos`,
            {
                method: "POST",
                headers: {
                    Authorization: basicAuthHeader(auth),
                    "User-Agent": "vscode-intelligit",
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("error", (err) => {
                    req.setTimeout(0);
                    fail(getErrorMessage(err));
                });
                res.on("aborted", () => {
                    req.setTimeout(0);
                    fail("Response aborted while creating repository");
                });
                res.on("data", (chunk: Buffer) => (data += chunk.toString()));
                res.on("end", () => {
                    req.setTimeout(0);
                    if (settled) return;
                    if (res.statusCode === 201) {
                        try {
                            const repo = parseJsonObject(data);
                            const cloneUrl = repo ? readCloneLink(repo) : undefined;
                            const htmlUrl = repo ? readLinkHref(repo, "self") : undefined;
                            if (!cloneUrl || !htmlUrl) {
                                fail("Invalid Bitbucket Server API response");
                                return;
                            }
                            succeed({ cloneUrl, sshUrl: "", htmlUrl });
                        } catch {
                            fail("Invalid Bitbucket Server API response");
                        }
                    } else {
                        const msg = tryExtractApiError(data);
                        fail(msg || `Bitbucket Server API returned ${res.statusCode}`);
                    }
                });
            },
        );
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            fail("Request timed out while creating repository");
        });
        req.on("error", (err) => {
            req.setTimeout(0);
            fail(getErrorMessage(err));
        });
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basicAuthHeader(auth: PublishAuth): string {
    return `Basic ${Buffer.from(`${auth.gitUsername}:${auth.token}`).toString("base64")}`;
}

function normalizeHttpBaseUrl(value: string): string {
    const url = new URL(value.trim());
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}

function validateHttpBaseUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return vscode.l10n.t("URL is required");
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "https:") return vscode.l10n.t("URL must start with https://");
        if (url.username || url.password)
            return vscode.l10n.t("Do not include credentials in the URL");
        return null;
    } catch {
        return vscode.l10n.t("Enter a valid URL");
    }
}

function readLinkHref(record: Record<string, unknown>, name: string): string | undefined {
    const links = record.links;
    if (!isRecord(links)) return undefined;
    const link = links[name];
    if (Array.isArray(link)) {
        for (const entry of link) {
            if (!isRecord(entry)) continue;
            const href = readString(entry, "href");
            if (href) return href;
        }
        return undefined;
    }
    return isRecord(link) ? readString(link, "href") : undefined;
}

function readCloneLink(record: Record<string, unknown>): string | undefined {
    const links = record.links;
    if (!isRecord(links) || !Array.isArray(links.clone)) return undefined;
    let fallback: string | undefined;
    for (const entry of links.clone) {
        if (!isRecord(entry)) continue;
        const href = readString(entry, "href");
        if (!href) continue;
        fallback ??= href;
        const name = readString(entry, "name");
        if (name === "https" || name === "http") return href;
    }
    return fallback;
}

function tryExtractApiError(raw: string): string | null {
    try {
        const obj = parseJsonObject(raw);
        if (!obj) return null;
        const message = readString(obj, "message");
        if (message) return message;
        const structuredMessage = obj.message;
        if (isRecord(structuredMessage) || Array.isArray(structuredMessage)) {
            const messages = collectStringMessages(structuredMessage);
            if (messages.length > 0) return messages.join("; ");
        }
        const error = readString(obj, "error");
        if (error) return error;
        const errors = obj.errors;
        if (Array.isArray(errors)) {
            const messages = errors
                .map((entry) => (isRecord(entry) ? readString(entry, "message") : undefined))
                .filter((entry): entry is string => Boolean(entry));
            if (messages.length > 0) return messages.join("; ");
        }
        return null;
    } catch {
        return raw.slice(0, 300) || null;
    }
}

function collectStringMessages(value: unknown): string[] {
    const messages: string[] = [];
    const visit = (entry: unknown): void => {
        if (typeof entry === "string") {
            const message = entry.trim();
            if (message) messages.push(message);
            return;
        }
        if (Array.isArray(entry)) {
            for (const item of entry) visit(item);
            return;
        }
        if (isRecord(entry)) {
            for (const item of Object.values(entry)) visit(item);
        }
    };
    visit(value);
    return messages;
}

async function runGitPushWithAskpass(
    cwd: string,
    remote: string,
    branch: string,
    remoteBranch: string,
    auth: { username: string; token: string },
): Promise<void> {
    const ref = remoteBranch === branch ? branch : `${branch}:${remoteBranch}`;
    await runGitCommandWithAskpass(cwd, ["push", "-u", remote, ref], auth);
}
