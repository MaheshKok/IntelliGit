/** A public GitHub repository identity, detached from any credentials in a Git remote. */
export interface GitHubIdentity {
    owner: string;
    repo: string;
}

/** Parses a Git remote only when it identifies a public github.com repository. */
export function githubIdentityFromRemote(remote: string): GitHubIdentity | null {
    const value = remote.trim();
    const scp = /^git@github\.com:([^?#]+)$/i.exec(value);
    if (scp) return githubIdentityFromName(scp[1].replace(/\.git$/, ""));
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (
        url.hostname.toLowerCase() !== "github.com" ||
        url.port ||
        url.password ||
        url.search ||
        url.hash ||
        !["https:", "ssh:", "git:"].includes(url.protocol) ||
        (url.protocol === "ssh:" && url.username !== "git") ||
        (url.protocol !== "ssh:" && url.username)
    ) {
        return null;
    }
    return githubIdentityFromName(
        url.pathname
            .replace(/^\//, "")
            .replace(/\/$/, "")
            .replace(/\.git$/, ""),
    );
}

/** Validates an API-provided `owner/repo` name before it can become a Git URL. */
export function githubIdentityFromName(name: string): GitHubIdentity | null {
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)$/.exec(name);
    if (!match || match[2] === "." || match[2] === "..") return null;
    return { owner: match[1], repo: match[2] };
}

/** Builds a browser compare destination from a validated identity and branch. */
export function githubCompareUrl(identity: GitHubIdentity, branch: string): string {
    return `${githubRepositoryUrl(identity)}/compare/${encodeURIComponent(branch)}?expand=1`;
}

/** Builds the fixed public browser home for an already validated identity. */
export function githubRepositoryUrl(identity: GitHubIdentity): string {
    return `https://github.com/${identity.owner}/${identity.repo}`;
}

/** Builds a credential-free parent fetch URL from validated GitHub metadata. */
export function githubCloneUrl(identity: GitHubIdentity): string {
    return `${githubRepositoryUrl(identity)}.git`;
}

/** Builds a committed file destination with an optional captured editor line anchor. */
export function githubBlobUrl(
    identity: GitHubIdentity,
    oid: string,
    filePath: string,
    anchor?: string,
): string {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error("Invalid commit OID");
    const segments = filePath.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("Invalid repository-relative path");
    }
    return `${githubRepositoryUrl(identity)}/blob/${oid}/${segments.map(encodeURIComponent).join("/")}${anchor ? `#${anchor}` : ""}`;
}

/** Validates a Gist API response URL before it is sent to external navigation. */
export function githubGistUrl(value: string): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (
        url.protocol !== "https:" ||
        url.hostname !== "gist.github.com" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/(?:[A-Za-z0-9-]+\/)?[0-9a-fA-F]{32,64}$/.test(url.pathname)
    ) {
        return null;
    }
    return url.href;
}
