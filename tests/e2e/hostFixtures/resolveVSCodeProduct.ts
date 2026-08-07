import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** VS Code version and commit, read from the downloaded build's own `product.json` rather than trusted from the version string a caller asked to download. */
export interface VSCodeProductInfo {
    readonly version: string;
    readonly commit: string;
}

const PRODUCT_JSON_RELATIVE_CANDIDATES = [
    // macOS: `<dir>/Visual Studio Code.app/Contents/Resources/app/product.json`
    path.join("Contents", "Resources", "app", "product.json"),
    // Linux / Windows: `<dir>/resources/app/product.json`
    path.join("resources", "app", "product.json"),
];

const MAX_WALK_DEPTH = 6;

/**
 * Locates and reads `product.json` for a downloaded VS Code build by walking
 * upward from the resolved main executable, rather than hardcoding a fixed
 * number of `..` hops from `executablePath`.
 *
 * That fixed-hop shortcut is exactly what broke inside `@vscode/test-electron`
 * itself: VS Code 1.110 renamed the macOS main binary from
 * `Contents/MacOS/Electron` to the product name (microsoft/vscode#291948),
 * and `node_modules/@vscode/test-electron/out/util.js`'s own
 * `resolveDarwinAppExecutable` had to grow a three-tier fallback to survive
 * it. Walking up and checking both known `product.json` layouts at each
 * level survives the same class of change without needing its own fallback
 * ladder.
 */
export function resolveVSCodeProductInfo(executablePath: string): VSCodeProductInfo {
    let dir = path.dirname(executablePath);

    for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
        for (const relativeCandidate of PRODUCT_JSON_RELATIVE_CANDIDATES) {
            const candidate = path.join(dir, relativeCandidate);
            if (existsSync(candidate)) {
                return readProductInfo(candidate);
            }
        }

        const parentDir = path.dirname(dir);
        if (parentDir === dir) break;
        dir = parentDir;
    }

    throw new Error(
        `Could not locate product.json by walking up from VS Code executable path: ${executablePath}`,
    );
}

function readProductInfo(productJsonPath: string): VSCodeProductInfo {
    const raw = readFileSync(productJsonPath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { version?: unknown }).version !== "string" ||
        typeof (parsed as { commit?: unknown }).commit !== "string"
    ) {
        throw new Error(
            `product.json at ${productJsonPath} is missing a string "version" or "commit" field`,
        );
    }

    const product = parsed as { version: string; commit: string };
    return { version: product.version, commit: product.commit };
}
