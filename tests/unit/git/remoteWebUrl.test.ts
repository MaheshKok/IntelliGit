import { describe, expect, it } from "vitest";
import { remoteUrlToWebUrl } from "../../../src/git/remoteWebUrl";

describe("remoteUrlToWebUrl", () => {
    it("converts the scp-like form every host hands out for SSH", () => {
        expect(remoteUrlToWebUrl("git@github.com:MaheshKok/IntelliGit.git")).toBe(
            "https://github.com/MaheshKok/IntelliGit",
        );
    });

    it("keeps nested group paths that GitLab and self-hosted forges use", () => {
        expect(remoteUrlToWebUrl("git@gitlab.com:group/subgroup/repo.git")).toBe(
            "https://gitlab.com/group/subgroup/repo",
        );
    });

    it("strips the .git suffix and trailing slash from an https remote", () => {
        expect(remoteUrlToWebUrl("https://bitbucket.org/team/repo.git")).toBe(
            "https://bitbucket.org/team/repo",
        );
        expect(remoteUrlToWebUrl("https://gitlab.com/group/repo/")).toBe(
            "https://gitlab.com/group/repo",
        );
    });

    it("drops the SSH port, which means nothing to a browser", () => {
        // 2222 is the sshd port. Carrying it over produces a dead https URL.
        expect(remoteUrlToWebUrl("ssh://git@gitlab.example.com:2222/group/sub/repo.git")).toBe(
            "https://gitlab.example.com/group/sub/repo",
        );
    });

    it("keeps an explicit port on an https remote, which is already a web port", () => {
        expect(remoteUrlToWebUrl("https://git.example.com:8443/team/repo.git")).toBe(
            "https://git.example.com:8443/team/repo",
        );
    });

    it("never carries embedded credentials into the browser", () => {
        // A remote cached by a credential helper carries the PAT in the URL. Handing
        // that to openExternal writes the token into browser history and the referrer.
        const converted = remoteUrlToWebUrl("https://mahesh:ghp_SECRETTOKEN@github.com/o/r.git");
        expect(converted).toBe("https://github.com/o/r");
        expect(converted).not.toContain("ghp_SECRETTOKEN");
        expect(converted).not.toContain("mahesh");

        const sshWithUser = remoteUrlToWebUrl("ssh://git@github.com/o/r.git");
        expect(sshWithUser).toBe("https://github.com/o/r");
        expect(sshWithUser).not.toContain("git@");
    });

    it("upgrades the git:// transport to https", () => {
        expect(remoteUrlToWebUrl("git://git.example.com/team/repo.git")).toBe(
            "https://git.example.com/team/repo",
        );
    });

    it("leaves a plain-http self-hosted remote on http", () => {
        expect(remoteUrlToWebUrl("http://git.internal/team/repo.git")).toBe(
            "http://git.internal/team/repo",
        );
    });

    it("rejects remotes that have no browsable page", () => {
        for (const local of [
            "/srv/git/repo.git",
            "./repo.git",
            "../sibling/repo.git",
            "~/repos/repo.git",
            "C:\\repos\\repo",
            "file:///srv/git/repo.git",
        ]) {
            expect(remoteUrlToWebUrl(local), local).toBeNull();
        }
    });

    it("rejects input with no repository path", () => {
        for (const empty of ["", "   ", "git@github.com:", "https://github.com/", "not a url"]) {
            expect(remoteUrlToWebUrl(empty), JSON.stringify(empty)).toBeNull();
        }
    });

    it("emits only http or https, whatever the input transport", () => {
        for (const remote of [
            "git@github.com:o/r.git",
            "ssh://git@h.example.com:22/o/r.git",
            "git://h.example.com/o/r.git",
            "https://h.example.com/o/r.git",
            "http://h.example.com/o/r.git",
        ]) {
            expect(remoteUrlToWebUrl(remote), remote).toMatch(/^https?:\/\//);
        }
    });
});
