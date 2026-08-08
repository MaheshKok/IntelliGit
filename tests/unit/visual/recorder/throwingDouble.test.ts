/**
 * Spec-derived tests for `tests/visual/recorder/throwingDouble.ts` -- the recursive test double
 * that must throw, BY NAME, on any member a caller did not explicitly implement, rather than
 * silently resolving to `undefined`. This is the load-bearing mechanism the Phase 2c webview
 * recorder relies on to keep a recorded fixture honest (see that file's own doc comment): a
 * double whose unimplemented API silently yields `undefined` lets real production code take a
 * branch no real user would ever hit, and a recording of that wrong branch is type-valid,
 * reviewable-looking, and wrong.
 *
 * Every test here is written to be able to fail: the "throws" tests assert on the exact thrown
 * message so a double that throws a generic, unnamed error would fail them, and the "forwards"
 * tests assert on real return values (not just "did not throw") so a double that swallows every
 * call and returns `undefined` would fail them too.
 */

import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { throwingDouble } from "../../../visual/recorder/throwingDouble";

describe("throwingDouble: implemented members", () => {
    it("returns the value for an explicitly implemented member", () => {
        const double = throwingDouble<{ cspSource: string }>("webview", { cspSource: "abc" });
        expect(double.cspSource).toBe("abc");
    });

    it("forwards a function value unchanged, and calling it works", () => {
        let called = false;
        const fn = (): string => {
            called = true;
            return "called";
        };
        const double = throwingDouble<{ postMessage: () => string }>("webview", {
            postMessage: fn,
        });

        expect(double.postMessage()).toBe("called");
        expect(called).toBe(true);
    });
});

describe("throwingDouble: unimplemented members throw loudly, by name", () => {
    it("throws naming the member for a top-level unimplemented member", () => {
        const double = throwingDouble<{ cspSource: string; html: string }>("webview", {
            cspSource: "abc",
        });

        expect(() => double.html).toThrow(/webview\.html/);
    });

    it("throws naming the FULL nested path for a nested unimplemented member", () => {
        const double = throwingDouble<{ window: { activeColorTheme?: unknown } }>("vscode", {
            window: {},
        });

        expect(() => double.window.activeColorTheme).toThrow(/vscode\.window\.activeColorTheme/);
    });

    it("a double that only throws for members nobody touches is untested -- prove BOTH halves in one double", () => {
        const double = throwingDouble<{ cspSource: string; html: string }>("webview", {
            cspSource: "known",
        });

        // The implemented half must actually work...
        expect(double.cspSource).toBe("known");
        // ...and the unimplemented half must actually throw, naming itself.
        expect(() => double.html).toThrow('throwingDouble: unimplemented member "webview.html"');
    });
});

describe("throwingDouble: recursive wrapping of nested plain objects", () => {
    it("wraps a nested plain-object member so ITS implemented members also work", () => {
        const double = throwingDouble<{ workspace: { onDidChangeConfiguration: () => string } }>(
            "vscode",
            { workspace: { onDidChangeConfiguration: () => "registered" } },
        );

        expect(double.workspace.onDidChangeConfiguration()).toBe("registered");
    });

    it("wraps a nested plain-object member so ITS unimplemented members also throw, by full path", () => {
        const double = throwingDouble<{ workspace: { getConfiguration?: () => unknown } }>(
            "vscode",
            { workspace: {} },
        );

        expect(() => double.workspace.getConfiguration).toThrow(
            'throwingDouble: unimplemented member "vscode.workspace.getConfiguration"',
        );
    });
});

describe("throwingDouble: values that are deliberately NOT wrapped", () => {
    it("does not wrap array values -- index access past the end yields undefined, not a throw", () => {
        const double = throwingDouble<{ localResourceRoots: unknown[] }>("options", {
            localResourceRoots: [],
        });

        expect(double.localResourceRoots[0]).toBeUndefined();
    });

    it("does not wrap class/constructor values -- instanceof against the real class still works", () => {
        class RealEventEmitter {
            fire(): string {
                return "fired";
            }
        }
        const double = throwingDouble<{ EventEmitter: typeof RealEventEmitter }>("vscode", {
            EventEmitter: RealEventEmitter,
        });

        const instance = new double.EventEmitter();
        expect(instance).toBeInstanceOf(RealEventEmitter);
        expect(instance.fire()).toBe("fired");
    });

    it("does not throw for symbol property access -- node inspection machinery stays usable on failure", () => {
        const double = throwingDouble<{ cspSource: string }>("webview", { cspSource: "abc" });

        expect(() => inspect(double)).not.toThrow();
    });
});

describe("throwingDouble: thenable-detection is never mistaken for an unimplemented member", () => {
    it('answers undefined for an unimplemented "then", instead of throwing', () => {
        const double = throwingDouble<{ cspSource: string; then?: unknown }>("webview", {
            cspSource: "abc",
        });

        // `typeof x.then === "function"` is how `await`, `Promise.resolve`, and (empirically, via
        // `recordCommitInfoWebviewFixture.test.ts`) Vite/vitest's own module-mocking machinery
        // probe ANY value for thenable-ness. A throw here breaks that ambient platform behavior
        // for every double this module builds, not just the code a test is actually exercising.
        expect(() => double.then).not.toThrow();
        expect(double.then).toBeUndefined();
    });

    it('still returns an EXPLICITLY implemented "then" rather than forcing it to undefined', () => {
        const thenImpl = (): string => "resolved";
        const double = throwingDouble<{ then: () => string }>("webview", { then: thenImpl });

        expect(double.then()).toBe("resolved");
    });
});

describe("throwingDouble: property writes fall through to the underlying object", () => {
    it("a write is never intercepted, and a later read observes it (models a mutable field)", () => {
        const raw: { options: Record<string, unknown> } = { options: { enableScripts: false } };
        const double = throwingDouble<{ options: Record<string, unknown> }>("webview", raw);

        double.options = { enableScripts: true, localResourceRoots: [] };

        expect(double.options).toEqual({ enableScripts: true, localResourceRoots: [] });
        // The write landed on the real underlying object, not just on the proxy's own view of it.
        expect(raw.options).toEqual({ enableScripts: true, localResourceRoots: [] });
    });
});
