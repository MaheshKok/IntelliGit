// Spec-derived tests for the two normalize helpers Phase 5 changes: an overridable
// CI/CD include pattern (the review-bot exclusion must stay unconditional) and an
// optional sign-in host on the unavailable snapshot (presence is the popover's signal
// to offer a "Sign in" button). Cases are written from the documented contract, not by
// mirroring the implementation. vscode.l10n is stubbed so the pure helpers run headless.

import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => message },
}));

import type { CommitCheckItem } from "../../../../src/types";
import {
    isCiCdCheckItem,
    unavailableSnapshot,
} from "../../../../src/services/commitChecks/normalize";

function item(name: string, description = ""): CommitCheckItem {
    return { name, description, state: "success", source: "check-run" };
}

describe("isCiCdCheckItem — default pattern (regression)", () => {
    it("keeps a build/ci check", () => {
        expect(isCiCdCheckItem(item("CI / build"))).toBe(true);
    });

    it("drops a row that matches neither ci/cd nor review terms", () => {
        expect(isCiCdCheckItem(item("license/cla"))).toBe(false);
    });

    it("drops a code-review bot even though it is otherwise unrelated to ci", () => {
        expect(isCiCdCheckItem(item("CodeRabbit"))).toBe(false);
        expect(isCiCdCheckItem(item("reviewdog"))).toBe(false);
    });

    it("matches against the description, not just the name", () => {
        expect(isCiCdCheckItem(item("status", "deploy to production"))).toBe(true);
    });
});

describe("isCiCdCheckItem — custom include pattern override", () => {
    it("includes a row the default would drop when the custom pattern matches it", () => {
        // "license" is not in the built-in CI/CD pattern; a custom filter can include it.
        const pattern = /license/i;
        expect(isCiCdCheckItem(item("license/cla"), pattern)).toBe(true);
        expect(isCiCdCheckItem(item("license/cla"))).toBe(false); // default still drops it
    });

    it("drops a row the default would keep when the custom pattern excludes it", () => {
        // A narrower custom include of only "deploy" must drop a generic build row.
        const pattern = /deploy/i;
        expect(isCiCdCheckItem(item("CI / build"), pattern)).toBe(false);
        expect(isCiCdCheckItem(item("deploy / prod"), pattern)).toBe(true);
    });

    it("applies the custom include case-insensitively when the pattern says so", () => {
        expect(isCiCdCheckItem(item("DEPLOY"), /deploy/i)).toBe(true);
    });

    it("keeps the review-bot exclusion unconditional even with a custom include", () => {
        // The custom pattern matches "coderabbit", but REVIEW exclusion must still win.
        const pattern = /coderabbit/i;
        expect(isCiCdCheckItem(item("CodeRabbit"), pattern)).toBe(false);
    });

    it("excludes a review bot whose name the custom include would otherwise admit", () => {
        // "reviewdog ci" matches a custom include of /ci/, but it is a review bot → excluded.
        expect(isCiCdCheckItem(item("reviewdog ci"), /ci/i)).toBe(false);
    });
});

describe("unavailableSnapshot — sign-in host", () => {
    it("produces an unavailable snapshot carrying the error and no sign-in host by default", () => {
        const snap = unavailableSnapshot("abc1234", "network down");
        expect(snap.hash).toBe("abc1234");
        expect(snap.state).toBe("unavailable");
        expect(snap.error).toBe("network down");
        expect(snap.items).toEqual([]);
        expect(snap.signInHost).toBeUndefined();
    });

    it("sets signInHost only when a host is passed (token-missing / 401 / 403 path)", () => {
        const snap = unavailableSnapshot("abc1234", "401 Unauthorized", "gitlab.acme.com");
        expect(snap.signInHost).toBe("gitlab.acme.com");
    });

    it("treats an empty-string host as no host (must not offer sign-in for a blank host)", () => {
        // A blank host is not actionable; the button needs a real host to target.
        const snap = unavailableSnapshot("abc1234", "boom", "");
        expect(snap.signInHost).toBeUndefined();
    });
});
