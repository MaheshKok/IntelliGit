/**
 * Spec-derived tests for `tests/visual/recorder/workspaceConfigurationDouble.ts`.
 *
 * The load-bearing case is the LAST one: a configuration object built while a store was installed
 * and then read AFTER `resetFakeWorkspaceConfigurationForTests`. That is not a hypothetical --
 * every recorder that installs a configuration resets it in its own `finally`, and a panel that
 * captured the object returned by `vscode.workspace.getConfiguration` reads it whenever it next
 * posts, which can be after the reset. Reading the module-level store at call time made that path
 * hand `undefined` to `Object.prototype.hasOwnProperty.call`, which throws `TypeError: Cannot
 * convert undefined or null to object` -- a failure that names nothing, replacing the precise
 * "uninstalled fake workspace configuration key" diagnostic this module exists to produce.
 *
 * Nothing else in the suite covers this: the recorders that use the double install a store and read
 * it back inside the same `try`, so they exercise only the still-installed path and stay green with
 * the snapshot removed.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
    createFakeWorkspaceConfiguration,
    resetFakeWorkspaceConfigurationForTests,
    setFakeWorkspaceConfiguration,
} from "../../../visual/recorder/workspaceConfigurationDouble";

afterEach(() => {
    resetFakeWorkspaceConfigurationForTests();
});

describe("createFakeWorkspaceConfiguration", () => {
    it("throws by section name when no store is installed", () => {
        expect(() => createFakeWorkspaceConfiguration("editor")).toThrow(
            /getConfiguration\("editor"\).*no fake workspace configuration is installed/s,
        );
    });

    it("resolves a pinned key through its fully qualified name", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });

        expect(createFakeWorkspaceConfiguration("editor").get<number>("fontSize")).toBe(14);
    });

    it("throws naming the resolved key when the key was never pinned", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });

        expect(() => createFakeWorkspaceConfiguration("editor").get("fontFamily")).toThrow(
            /uninstalled fake workspace configuration key "editor\.fontFamily"/,
        );
    });

    // An explicitly pinned `undefined` is dropped at install time so a caller cannot make an absent
    // setting look present -- the key must then be reported as uninstalled, not returned as
    // `undefined`, which is what a real unset setting looks like.
    it("treats an explicitly undefined value as never pinned", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": undefined });

        expect(() => createFakeWorkspaceConfiguration("editor").get("fontSize")).toThrow(
            /uninstalled fake workspace configuration key "editor\.fontSize"/,
        );
    });

    it("keeps serving its snapshot after the store is reset, instead of dying with a TypeError", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });
        const configuration = createFakeWorkspaceConfiguration("editor");

        resetFakeWorkspaceConfigurationForTests();

        expect(configuration.get<number>("fontSize")).toBe(14);
        // The unpinned key must still fail with this module's own named diagnostic after a reset --
        // a `TypeError` here would mean the reset turned a precise error into an anonymous one.
        expect(() => configuration.get("fontFamily")).toThrow(
            /uninstalled fake workspace configuration key "editor\.fontFamily"/,
        );
    });

    it("is unaffected by a later install -- the snapshot is taken at construction", () => {
        setFakeWorkspaceConfiguration({ "editor.fontSize": 14 });
        const configuration = createFakeWorkspaceConfiguration("editor");

        setFakeWorkspaceConfiguration({ "editor.fontSize": 99 });

        expect(configuration.get<number>("fontSize")).toBe(14);
    });
});
