import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(__dirname, "../../../src");

const CALL = "registerWebviewViewProvider(";

/** Returns the argument text of every `registerWebviewViewProvider(...)` call in `source`. */
function registrationCalls(source: string): readonly string[] {
    const calls: string[] = [];
    for (
        let cursor = source.indexOf(CALL);
        cursor !== -1;
        cursor = source.indexOf(CALL, cursor + 1)
    ) {
        let depth = 0;
        for (let index = cursor + CALL.length - 1; index < source.length; index += 1) {
            if (source[index] === "(") depth += 1;
            else if (source[index] === ")") {
                depth -= 1;
                if (depth === 0) {
                    calls.push(source.slice(cursor + CALL.length, index));
                    break;
                }
            }
        }
    }
    return calls;
}

/** Every commit-panel registration in the extension source, as `file: arguments` pairs. */
function commitPanelRegistrations(): readonly { readonly site: string; readonly args: string }[] {
    return readdirSync(SRC_DIR, { recursive: true })
        .map(String)
        .filter((relativePath) => relativePath.endsWith(".ts"))
        .flatMap((relativePath) =>
            registrationCalls(readFileSync(path.join(SRC_DIR, relativePath), "utf8"))
                .filter((args) => args.includes("CommitPanelViewProvider.viewType"))
                .map((args) => ({ site: relativePath, args })),
        );
}

/**
 * `retainContextWhenHidden` is fixed when a view provider is registered and can never be added
 * afterwards -- `SwitchableWebviewViewProvider.setProvider` swaps the provider behind an already
 * registered view, not the view's options. So the commit panel keeps or discards its state
 * depending on which activation path happened to register it first, and the two paths had drifted:
 * the repository path passed the option and the no-repository path did not, leaving a workspace
 * that gained its first repository after startup with a panel that is rebuilt from scratch on every
 * hide. The difference is invisible in both files, because neither one names the other.
 *
 * The registrations are discovered rather than listed. A test that named today's two call sites
 * would gate exactly the drift it already knew about and pass for a third path added later, which
 * is the shape of the bug it exists to prevent.
 */
describe("commit-panel webview registration", () => {
    it("retains context on every activation path that registers the panel", () => {
        const registrations = commitPanelRegistrations();

        // Zero found reads identically to zero offenders, and the scan is the part most likely to
        // silently stop matching -- a renamed API, a reformatted call, a moved directory.
        expect(
            registrations.map(({ site }) => site),
            `no commit-panel registrations found under ${SRC_DIR}; the scan, not the source, is broken`,
        ).not.toEqual([]);

        const offenders = registrations
            .filter(({ args }) => !/retainContextWhenHidden:\s*true/.test(args))
            .map(({ site }) => site);

        expect(
            offenders,
            "These activation paths register the commit panel without " +
                "`{ webviewOptions: { retainContextWhenHidden: true } }`. The option cannot be " +
                "added later, so the panel silently loses its state on hide depending on how the " +
                "workspace activated.",
        ).toEqual([]);
    });
});
