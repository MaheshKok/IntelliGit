/**
 * A recursive test double that throws, BY NAME, on any member a caller did not explicitly
 * implement -- rather than silently resolving to `undefined` the way a plain object literal
 * (or a `vi.fn()`-sprinkled mock built the same way) would.
 *
 * This is the mechanism the Phase 2c webview recorder relies on to keep a recorded fixture
 * honest. A recorder that fakes `vscode` (or a `vscode.WebviewView`) with a plain object stays
 * transparent right up until the real production code under test reaches for a member the fake
 * never implemented: a plain object silently hands back `undefined`, the real emitter takes
 * whatever branch `undefined` sends it down, and the recorder commits a fixture for a screen no
 * real user would ever see -- type-valid, reviewable-looking, and wrong. `throwingDouble` turns
 * that same reach into a loud, named failure at record time instead, so a scenario that touches
 * an unmodeled corner of the real `vscode` surface fails the recording run rather than silently
 * producing a fixture for a branch the fake happened to fall into.
 *
 * Nested plain-object members are wrapped recursively (own enumerable properties only), so
 * `vscode.window.showErrorMessage` is exactly as loudly unimplemented as `vscode.window` itself
 * would be if `window` were left out of the double entirely. Functions and class/constructor
 * values are handed back as-is: this codebase's `vscode` doubles never read a static property
 * off a function value, so wrapping one would buy nothing, and doing so would additionally break
 * `instanceof` checks against constructor values such as `vscode.EventEmitter`. Arrays are
 * likewise handed back as-is -- index access past the end of a deliberately short implementation
 * array (e.g. an empty webview `localResourceRoots` list) is meant to yield `undefined`, not
 * throw.
 *
 * A property WRITE (`webview.options = {...}`) is never intercepted -- there is no `set` trap --
 * so it falls through to the Proxy's default behavior, which writes straight onto the
 * underlying implementation object. That write then makes the property a genuine own property,
 * so a later read succeeds normally. This is what lets a double model a mutable field (VS Code's
 * own `webview.options` is reassigned wholesale, never patched) without the double needing a
 * bespoke setter for every mutable member production code happens to reassign.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return false;
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Wraps `implementation` in a `Proxy` that forwards every explicitly-implemented own property
 * (recursively, for plain-object property values) and throws a descriptive, named error for
 * anything else. `path` is prepended to the thrown message so a deeply nested miss --
 * `vscode.workspace.fs`, say -- names its full address in the error, not just the leaf property,
 * which is what makes the thrown message actionable without a debugger.
 *
 * `path` is also what a caller re-wrapping a nested object passes down one level at a time (see
 * the recursive call below) -- callers of this function directly always pass the double's own
 * top-level name (e.g. `"vscode"`).
 */
export function throwingDouble<T extends object>(path: string, implementation: Partial<T>): T {
    return new Proxy(implementation as T, {
        get(target, prop, receiver) {
            if (typeof prop === "symbol") {
                // Node/vitest machinery (console formatting, `util.inspect`, etc.) probes
                // well-known symbols on values it is about to print, most commonly when a test
                // assertion fails. Throwing on those turns a helpful failure message into a
                // second, unrelated crash, so symbol access always falls through untouched.
                return Reflect.get(target as object, prop, receiver);
            }
            if (prop === "then" && !Object.prototype.hasOwnProperty.call(target, "then")) {
                // Thenable-detection (`typeof x.then === "function"`) is reflexively probed by
                // `await`, `Promise.resolve(x)`, and -- empirically, via this module's own
                // `recordCommitInfoWebviewFixture.test.ts` -- Vite/vitest's `vi.mock` factory-
                // result handling, on ANY value it is about to resolve. That is never "the code
                // under test reached an unexpected path" the way every other unimplemented member
                // is; it is ambient platform/tooling behavior a plain, un-proxied double would
                // answer with `undefined` (no "then" own property), so a throwingDouble-wrapped
                // value must answer the same way to avoid being mistaken for a thenable.
                return undefined;
            }
            if (!Object.prototype.hasOwnProperty.call(target, prop)) {
                throw new Error(
                    `throwingDouble: unimplemented member "${path}.${prop}" was accessed. Either ` +
                        `the code under test reached an unexpected path, or this member is ` +
                        `genuinely needed here -- add it to the double explicitly rather than ` +
                        `letting it silently resolve to undefined.`,
                );
            }
            const value = Reflect.get(target as object, prop, receiver);
            if (isPlainObject(value)) {
                return throwingDouble(`${path}.${String(prop)}`, value);
            }
            return value;
        },
    });
}
