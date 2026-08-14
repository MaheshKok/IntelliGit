// The `VsCodeApi` shape, kept in its own leaf module so it can be imported without pulling in
// `vscodeApi.ts`'s behavior.
//
// `vscodeApi.ts` installs the E2E control channel's webview leg (`installE2eStateBridge`), and
// that bridge in turn needs this type to describe the handle it operates on. Declaring the type
// inside `vscodeApi.ts` made those two modules import each other, which
// `.dependency-cruiser.cjs`'s `no-circular` rule rejects -- and rightly so here: the project sets
// `tsPreCompilationDeps: true`, so a type-only edge still counts as a dependency. Splitting the
// type out breaks the cycle structurally rather than exempting it, and leaves every existing
// `import type { VsCodeApi } from "./shared/vscodeApi"` working via the re-export there.

/**
 * Minimal VS Code webview API facade used by React webview modules.
 *
 * Outbound messages are posted to the extension host, while state values are
 * persisted by VS Code for the lifetime of the webview instance.
 */
export interface VsCodeApi<Outbound = unknown, State = unknown> {
    postMessage(msg: Outbound): void;
    getState(): State | undefined;
    setState(state: State): void;
}
