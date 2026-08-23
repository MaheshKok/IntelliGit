// The set of VS Code theme tokens this extension actually reads, derived from the source rather
// than listed by hand. `compare.spec.ts` narrows its cross-build comparison to these: see
// `hostFixtureComparator.ts` for why an unread token cannot be an early warning.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * File types that can name a theme token. Webview styles live in `.ts`/`.tsx` inline styles and
 * `.css`, and the shell HTML built by `buildWebviewShellHtml` names them in a template literal --
 * so restricting by extension is about skipping binaries, not about narrowing the search.
 */
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".css", ".html"]);

/**
 * Matches a token NAME wherever it appears -- `var(--vscode-foo)`, a nested fallback, or a bare
 * mention. Every reference in this repository writes the name literally; only the FALLBACK is ever
 * interpolated (`var(--vscode-menu-border, ${JETBRAINS_UI.color.menuBorder})`), which this still
 * matches.
 */
const THEME_TOKEN_PATTERN = /--vscode-[A-Za-z0-9_-]+/g;

/**
 * A token NAME assembled from a template expression, which `THEME_TOKEN_PATTERN` cannot read whole.
 *
 * Both shapes are invisible, and the second is the worse one: `--vscode-${x}` matches nothing and
 * drops out of the set silently, while `--vscode-menu-${x}` matches the `--vscode-menu-` PREFIX and
 * enters the set as a token that does not exist. Either way the real token stops being compared
 * with nothing going red, so the scan refuses to guess and fails instead.
 *
 * Deliberately not `g`: `exec` on a global regex carries `lastIndex` between calls, so reusing one
 * across files would start each search wherever the previous file happened to stop.
 */
const INTERPOLATED_TOKEN_NAME_PATTERN = /--vscode-[A-Za-z0-9_-]*\$\{/;

/**
 * Fail-loud floor, not a target. This set is the whole filter, so a scan that silently returns
 * nothing -- a moved source tree, a renamed extension, a broken pattern -- would not fail: it would
 * quietly compare zero tokens and pass forever, which is the same as deleting the canary. 81 tokens
 * are referenced as of 2026-08-23; the floor sits well below that so genuine consolidation does not
 * trip it, and well above zero so a broken scan does.
 */
const MINIMUM_EXPECTED_TOKENS = 40;

/**
 * Reads every theme token referenced anywhere under `src`.
 *
 * @throws When the scan finds implausibly few tokens, which means the scan broke rather than that
 * the extension stopped theming itself.
 */
export function readConsumedThemeTokens(repoRoot: string): ReadonlySet<string> {
    const sourceRoot = path.join(repoRoot, "src");
    const tokens = new Set<string>();

    for (const entry of readdirSync(sourceRoot, { recursive: true })) {
        const relativePath = String(entry);
        if (!SCANNED_EXTENSIONS.has(path.extname(relativePath))) continue;
        const contents = readFileSync(path.join(sourceRoot, relativePath), "utf8");
        const interpolated = INTERPOLATED_TOKEN_NAME_PATTERN.exec(contents);
        if (interpolated !== null) {
            throw new Error(
                `${relativePath} builds a theme token NAME by interpolation ` +
                    `(${interpolated[0]}...). The scan reads names literally, so this token would ` +
                    `drop out of the Insiders comparison -- or worse, enter it as the truncated ` +
                    `prefix -- with nothing going red. Write the name out and interpolate only ` +
                    `the fallback: var(--vscode-menu-border, \${JETBRAINS_UI.color.menuBorder}).`,
            );
        }
        for (const match of contents.matchAll(THEME_TOKEN_PATTERN)) {
            tokens.add(match[0]);
        }
    }

    if (tokens.size < MINIMUM_EXPECTED_TOKENS) {
        throw new Error(
            `Scanned ${sourceRoot} and found only ${tokens.size} VS Code theme tokens, below the ` +
                `${MINIMUM_EXPECTED_TOKENS} this repository is known to reference. The scan is ` +
                `broken, not the extension -- narrowing the Insiders comparison to an empty set ` +
                `would silently pass every future theme change.`,
        );
    }

    return tokens;
}
