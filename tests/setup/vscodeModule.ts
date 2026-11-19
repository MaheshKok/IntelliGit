// Where `vscode` resolves in tests (vitest.config.ts `resolve.alias`). The real module exists
// only inside the extension host, so a test that reaches it must mock it with
// `vi.mock("vscode", ...)`, which replaces this file. Without the alias a jsdom test that
// renders a webview and also drives host code cannot even mock it: the browser-side transform
// refuses an import it cannot resolve before any mock applies.
throw new Error('The "vscode" module exists only in the extension host; mock it with vi.mock.');
