import type { WebviewContextId } from "../../../src/e2e/webviewCapture";

/**
 * The resolved host-context shell table is keyed by the host that calls the production shell, not
 * by its bundle. One bundle can serve multiple hosts, and one host class can be constructed with
 * different bundle options; collapsing either relationship would make the Phase 6 drift oracle
 * compare the wrong production contract.
 *
 * This module intentionally contains no renderer, HTML, filesystem, or recorder code. It is the
 * checked-in data contract that the recorder-backed oracle pins to production before a harness can
 * consume it.
 */

/** A title passed to the shell, retaining whether production localized it or used a literal. */
export type HostContextTitleDescriptor =
    | { readonly kind: "localized"; readonly key: string }
    | { readonly kind: "literal"; readonly value: string };

/** The production shell inputs that vary by resolved host context. */
export interface ResolvedHostContext {
    readonly contextId: WebviewContextId;
    readonly scriptFile: string;
    readonly styleFiles: readonly string[];
    readonly declaredBackgroundVar: string | undefined;
    readonly resolvedBackgroundVar: string;
    readonly titleDescriptor: HostContextTitleDescriptor;
}

/** Fields compared when two resolved hosts share one production bundle. */
type SharedBundleField =
    | "scriptFile"
    | "styleFiles"
    | "declaredBackgroundVar"
    | "resolvedBackgroundVar"
    | "titleDescriptor";

/** One explicit declaration of which fields may differ within a shared-bundle group. */
export interface SharedBundleEquivalence {
    readonly scriptFile: string;
    readonly contextIds: readonly WebviewContextId[];
    readonly allowedDivergences: readonly SharedBundleField[];
}

const DEFAULT_BACKGROUND_VAR = "var(--vscode-editor-background)";

/**
 * Production shell options, recorded by resolved host context.
 *
 * `declaredBackgroundVar` deliberately retains omission as `undefined`; storing only
 * `resolvedBackgroundVar` would make an explicit production argument disappearing indistinguishable
 * from the current default and would let that source-level contract drift silently.
 *
 * Dynamic localized titles store the catalog key rather than a filename-specific rendered value.
 * The recorder-backed oracle captures the `vscode.l10n.t` argument from the real host and therefore
 * checks the stable key without pretending the filename-specific rendered title is static.
 */
export const WEBVIEW_HOST_CONTEXTS: readonly ResolvedHostContext[] = [
    {
        contextId: "commit-graph-card",
        scriptFile: "webview-commitgraph.js",
        styleFiles: [],
        declaredBackgroundVar: DEFAULT_BACKGROUND_VAR,
        resolvedBackgroundVar: DEFAULT_BACKGROUND_VAR,
        titleDescriptor: { kind: "literal", value: "Commit Graph" },
    },
    {
        contextId: "commit-graph-compact",
        scriptFile: "webview-compactcommitgraph.js",
        styleFiles: [],
        declaredBackgroundVar: DEFAULT_BACKGROUND_VAR,
        resolvedBackgroundVar: DEFAULT_BACKGROUND_VAR,
        titleDescriptor: { kind: "localized", key: "Graph" },
    },
    {
        contextId: "commit-panel",
        scriptFile: "webview-commitpanel.js",
        styleFiles: [],
        declaredBackgroundVar: "var(--vscode-sideBar-background, var(--vscode-editor-background))",
        resolvedBackgroundVar: "var(--vscode-sideBar-background, var(--vscode-editor-background))",
        titleDescriptor: { kind: "localized", key: "Changes" },
    },
    {
        contextId: "commit-info",
        scriptFile: "webview-commitinfo.js",
        styleFiles: [],
        declaredBackgroundVar: DEFAULT_BACKGROUND_VAR,
        resolvedBackgroundVar: DEFAULT_BACKGROUND_VAR,
        titleDescriptor: { kind: "localized", key: "Changed Files" },
    },
    {
        contextId: "undocked",
        scriptFile: "webview-undocked.js",
        styleFiles: [],
        declaredBackgroundVar: DEFAULT_BACKGROUND_VAR,
        resolvedBackgroundVar: DEFAULT_BACKGROUND_VAR,
        titleDescriptor: { kind: "localized", key: "IntelliGit" },
    },
    {
        contextId: "merge-editor",
        scriptFile: "webview-mergeeditor.js",
        styleFiles: ["webview-mergeeditor.css"],
        declaredBackgroundVar: undefined,
        resolvedBackgroundVar: DEFAULT_BACKGROUND_VAR,
        titleDescriptor: { kind: "localized", key: "Merge: {file}" },
    },
    {
        contextId: "shelf-conflict-editor",
        scriptFile: "webview-mergeeditor.js",
        styleFiles: ["webview-mergeeditor.css"],
        declaredBackgroundVar: undefined,
        resolvedBackgroundVar: DEFAULT_BACKGROUND_VAR,
        titleDescriptor: { kind: "localized", key: "Resolve shelf conflict: {file}" },
    },
    {
        contextId: "merge-conflict-session",
        scriptFile: "webview-mergeconflictsession.js",
        styleFiles: ["webview-mergeconflictsession.css"],
        declaredBackgroundVar: undefined,
        resolvedBackgroundVar: DEFAULT_BACKGROUND_VAR,
        titleDescriptor: { kind: "localized", key: "Conflicts" },
    },
] as const;

/**
 * The only currently shared bundle has two hosts whose title descriptors are intentionally distinct.
 * Keeping this list explicit makes a future shared bundle fail review unless its allowed divergence
 * is named; the equivalence oracle rejects every unlisted field difference.
 */
export const SHARED_BUNDLE_EQUIVALENCE: readonly SharedBundleEquivalence[] = [
    {
        scriptFile: "webview-mergeeditor.js",
        contextIds: ["merge-editor", "shelf-conflict-editor"],
        allowedDivergences: ["titleDescriptor"],
    },
] as const;

/** Every field a shared-bundle group must agree on unless its entry names the divergence. */
const SHARED_BUNDLE_FIELDS: readonly SharedBundleField[] = [
    "scriptFile",
    "styleFiles",
    "declaredBackgroundVar",
    "resolvedBackgroundVar",
    "titleDescriptor",
];

/**
 * Looks up a resolved host context in an arbitrary table, failing loudly if it has no row for it.
 *
 * Returning `undefined` would let a downstream harness accidentally skip a missing row and report
 * green. The explicit throw makes a stale or incomplete table a test failure at the lookup site.
 */
function hostContextIn(
    contexts: readonly ResolvedHostContext[],
    id: WebviewContextId,
): ResolvedHostContext {
    const context = contexts.find((candidate) => candidate.contextId === id);
    if (context === undefined) {
        throw new Error(`No resolved host context is registered for "${id}".`);
    }
    return context;
}

/** Looks up a row of the production table. See `hostContextIn` for why this throws. */
export function hostContextFor(id: WebviewContextId): ResolvedHostContext {
    return hostContextIn(WEBVIEW_HOST_CONTEXTS, id);
}

/**
 * Fails when hosts sharing one bundle diverge in a field their equivalence entry did not name, when
 * a shared bundle declares no entry at all, when an entry claims a bundle only one host uses, or
 * when an entry's `contextIds` is not exactly the set of hosts that actually use that bundle (a
 * real member missing from `contextIds`, an id that does not belong to the bundle, or a duplicate
 * id). That last check has to run in both directions: checking only that declared ids are real
 * would still let an entry silently omit a real member, and an omitted member never reaches the
 * field comparison below, so its shell fields could diverge from the rest of the group unnoticed.
 *
 * Parameterized over the table rather than closing over `WEBVIEW_HOST_CONTEXTS` so a test can run it
 * against a table built to violate it. A guard reachable only through the real (passing) table
 * proves nothing about its own reachability -- see `tests/fixtures/repo/scenarios.ts`.
 */
export function assertSharedBundleEquivalence(
    contexts: readonly ResolvedHostContext[],
    equivalences: readonly SharedBundleEquivalence[],
): void {
    const byScriptFile = new Map<string, ResolvedHostContext[]>();
    for (const context of contexts) {
        byScriptFile.set(context.scriptFile, [
            ...(byScriptFile.get(context.scriptFile) ?? []),
            context,
        ]);
    }

    for (const [scriptFile, members] of byScriptFile) {
        const isDeclared = equivalences.some((entry) => entry.scriptFile === scriptFile);
        if (members.length > 1 && !isDeclared) {
            throw new Error(
                `Bundle "${scriptFile}" is shared by ${members.length} host contexts but declares ` +
                    `no shared-bundle equivalence entry.`,
            );
        }
        if (members.length === 1 && isDeclared) {
            throw new Error(
                `Bundle "${scriptFile}" declares a shared-bundle equivalence entry but only one ` +
                    `host context uses it.`,
            );
        }
    }

    for (const equivalence of equivalences) {
        // Membership must hold in both directions, not just "every declared id resolves to a real
        // context" (which the lookup below already guarantees on its own). A one-way check is
        // exactly what let an entry omit a real member of the bundle: that member would never reach
        // the field comparison further down, so its shell fields could diverge from the rest of the
        // group and nothing here would notice.
        const declaredIds = new Set<WebviewContextId>();
        for (const id of equivalence.contextIds) {
            if (declaredIds.has(id)) {
                throw new Error(
                    `Shared-bundle equivalence entry for "${equivalence.scriptFile}" lists context ` +
                        `"${id}" in contextIds more than once.`,
                );
            }
            declaredIds.add(id);
        }

        const actualMembers = byScriptFile.get(equivalence.scriptFile) ?? [];
        for (const id of declaredIds) {
            if (!actualMembers.some((context) => context.contextId === id)) {
                throw new Error(
                    `Shared-bundle equivalence entry for "${equivalence.scriptFile}" lists context ` +
                        `"${id}" in contextIds, but no host context with that id uses this bundle.`,
                );
            }
        }
        for (const member of actualMembers) {
            if (!declaredIds.has(member.contextId)) {
                throw new Error(
                    `Host context "${member.contextId}" shares bundle "${equivalence.scriptFile}" ` +
                        `but is missing from its shared-bundle equivalence entry's contextIds.`,
                );
            }
        }

        const [first, ...rest] = equivalence.contextIds.map((id) => hostContextIn(contexts, id));
        for (const field of SHARED_BUNDLE_FIELDS) {
            if (equivalence.allowedDivergences.includes(field)) continue;
            for (const member of rest) {
                // Every field is plain JSON-shaped data authored in one place, so a structural
                // compare is exact here; the alternative (per-field bespoke comparison) would grow
                // a new branch every time the interface gains a field.
                if (JSON.stringify(member[field]) !== JSON.stringify(first[field])) {
                    throw new Error(
                        `Hosts "${first.contextId}" and "${member.contextId}" share bundle ` +
                            `"${equivalence.scriptFile}" but their "${field}" values differ, and ` +
                            `"${field}" is not listed in allowedDivergences.`,
                    );
                }
            }
        }
    }
}
