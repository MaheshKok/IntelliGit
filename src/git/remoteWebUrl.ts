/**
 * Host-agnostic conversion of a git remote URL into the page a browser can open.
 *
 * The commit-check providers each parse remotes too, but they are pinned to one
 * host and return API references. "Open Repository" has to work on whatever forge
 * the user actually pushes to, including self-hosted ones, so this is deliberately
 * shape-driven rather than host-driven.
 */

/**
 * `git@host:owner/repo.git`, the form every forge prints in its clone box.
 *
 * The host is required to be at least two characters so a Windows drive letter
 * (`C:\repos\repo`) cannot be read as a host, and any `user@` prefix is matched
 * but not captured — credentials never reach the output.
 */
const SCP_LIKE_REMOTE = /^(?:[^@/\s]+@)?([^@/:\s]{2,}):(.+)$/;

/** Remote forms that address a filesystem, and so have no page to open. */
function isLocalPath(value: string): boolean {
    return (
        value.startsWith("/") ||
        value.startsWith(".") ||
        value.startsWith("~") ||
        /^[A-Za-z]:[\\/]/.test(value)
    );
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

/**
 * Converts a git remote URL into an `http(s)` page URL, or `null` when the remote
 * has no browsable page.
 *
 * The returned URL is rebuilt from parsed parts rather than edited in place, which
 * is what guarantees embedded credentials are dropped: `URL.host` and
 * `URL.hostname` both exclude the userinfo section.
 */
export function remoteUrlToWebUrl(remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim();
    if (!trimmed || isLocalPath(trimmed)) {
        return null;
    }

    // A scheme-bearing remote is never scp-like; testing it first stops `https` from
    // being read as the host of `https://...`.
    const scpMatch = trimmed.includes("://") ? null : SCP_LIKE_REMOTE.exec(trimmed);
    const url = parseUrl(scpMatch ? `ssh://${scpMatch[1]}/${scpMatch[2]}` : trimmed);
    if (!url) {
        return null;
    }

    const isWebScheme = url.protocol === "http:" || url.protocol === "https:";
    if (!isWebScheme && url.protocol !== "ssh:" && url.protocol !== "git:") {
        return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const repository = segments.pop()?.replace(/\.git$/, "");
    if (!repository) {
        return null;
    }

    // An https remote's port is already a web port and has to survive; an ssh or git
    // port addresses a different daemon entirely and would produce a dead link.
    const host = isWebScheme ? url.host : url.hostname;
    if (!host) {
        return null;
    }

    const scheme = isWebScheme ? url.protocol : "https:";
    return `${scheme}//${host}/${[...segments, repository].join("/")}`;
}
