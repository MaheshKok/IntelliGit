// Spec-derived tests for the E2E control channel's checked-in allowlists. The contract is
// "allowlisted keys only -- an explicit list of the Memento keys, secret keys, and webview
// state keys this suite touches. An unlisted key is a rejection, not a passthrough."
// (PLAN.md Phase 1 step 10). Every real key sourced from production call sites must pass,
// and lookalike/unlisted keys of each kind must be rejected.

import { describe, expect, it } from "vitest";
import {
    isAllowedMementoKey,
    isAllowedSecretKey,
    isAllowedWebviewStateKey,
    MEMENTO_ALLOWLIST,
    SECRET_ALLOWLIST,
    WEBVIEW_STATE_ALLOWLIST,
} from "../../../src/e2e/allowlist";

describe("Memento allowlist", () => {
    it("allows every real workspace-scoped key", () => {
        expect(isAllowedMementoKey("workspace", "intelligit.selectedRepositoryRoot")).toBe(true);
        expect(isAllowedMementoKey("workspace", "intelligit.undockedSelectedRepositoryRoot")).toBe(
            true,
        );
    });

    it("allows every real global-scoped key", () => {
        expect(isAllowedMementoKey("global", "intelligit.reviewPrompt.status")).toBe(true);
        expect(isAllowedMementoKey("global", "intelligit.reviewPrompt.installedAt")).toBe(true);
        expect(isAllowedMementoKey("global", "intelligit.commitChecks.cache.v1")).toBe(true);
    });

    it("rejects an unlisted key even when it looks plausible", () => {
        expect(isAllowedMementoKey("workspace", "intelligit.someOtherKey")).toBe(false);
        expect(isAllowedMementoKey("global", "intelligit.selectedRepositoryRootExtra")).toBe(false);
    });

    it("rejects a real key requested under the wrong scope", () => {
        // A workspace-only key must not be reachable via the global Memento, and vice versa --
        // scope is part of the identity, not an interchangeable namespace.
        expect(isAllowedMementoKey("global", "intelligit.selectedRepositoryRoot")).toBe(false);
        expect(isAllowedMementoKey("workspace", "intelligit.reviewPrompt.status")).toBe(false);
    });

    it("rejects the empty string", () => {
        expect(isAllowedMementoKey("workspace", "")).toBe(false);
        expect(isAllowedMementoKey("global", "")).toBe(false);
    });

    it("has no cross-scope duplicate entries", () => {
        const workspaceKeys = MEMENTO_ALLOWLIST.workspace.length;
        const globalKeys = MEMENTO_ALLOWLIST.global.length;
        expect(workspaceKeys).toBeGreaterThan(0);
        expect(globalKeys).toBeGreaterThan(0);
    });
});

describe("Secret allowlist", () => {
    it("allows the real commit-checks token pattern for any host", () => {
        expect(isAllowedSecretKey("intelligit.commitChecks.token:gitlab.com")).toBe(true);
        expect(isAllowedSecretKey("intelligit.commitChecks.token:gitlab.acme.com")).toBe(true);
        expect(isAllowedSecretKey("intelligit.commitChecks.token:bitbucket.acme.com:8443")).toBe(
            true,
        );
    });

    it("rejects a key with an unrelated prefix", () => {
        expect(isAllowedSecretKey("intelligit.otherSecret.token:gitlab.com")).toBe(false);
    });

    it("rejects a key with no host suffix", () => {
        expect(isAllowedSecretKey("intelligit.commitChecks.token:")).toBe(false);
        expect(isAllowedSecretKey("intelligit.commitChecks.token")).toBe(false);
    });

    it("rejects a host suffix carrying a path-traversal or injection attempt", () => {
        expect(isAllowedSecretKey("intelligit.commitChecks.token:../../etc/passwd")).toBe(false);
        expect(isAllowedSecretKey("intelligit.commitChecks.token:host/evil")).toBe(false);
        expect(isAllowedSecretKey("intelligit.commitChecks.token:host\nX-Injected: 1")).toBe(false);
    });

    it("rejects the empty string", () => {
        expect(isAllowedSecretKey("")).toBe(false);
    });

    it("has at least one rule", () => {
        expect(SECRET_ALLOWLIST.length).toBeGreaterThan(0);
    });
});

describe("Webview state allowlist", () => {
    it("allows every real top-level persisted-state key", () => {
        for (const key of [
            "groupByDir",
            "showIgnoredFiles",
            "showIgnoredFilesByRepository",
            "checked",
            "checkedByRepository",
            "branchColumn",
        ]) {
            expect(isAllowedWebviewStateKey(key)).toBe(true);
        }
    });

    it("allows unprefixed and prefixed branchWidth/infoWidth keys", () => {
        expect(isAllowedWebviewStateKey("branchWidth")).toBe(true);
        expect(isAllowedWebviewStateKey("infoWidth")).toBe(true);
        expect(isAllowedWebviewStateKey("repo-1.branchWidth")).toBe(true);
        expect(isAllowedWebviewStateKey("repo-1.infoWidth")).toBe(true);
    });

    it("rejects an unlisted key", () => {
        expect(isAllowedWebviewStateKey("somethingElse")).toBe(false);
        expect(isAllowedWebviewStateKey("checkedExtra")).toBe(false);
    });

    it("rejects a malformed prefixed width key", () => {
        expect(isAllowedWebviewStateKey("branchWidthExtra")).toBe(false);
        expect(isAllowedWebviewStateKey("repo.1.branchWidth")).toBe(false);
    });

    it("rejects the empty string", () => {
        expect(isAllowedWebviewStateKey("")).toBe(false);
    });

    it("has at least one rule", () => {
        expect(WEBVIEW_STATE_ALLOWLIST.length).toBeGreaterThan(0);
    });
});
