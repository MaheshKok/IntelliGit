import fs from "node:fs";
import path from "node:path";

import type { HostFixtureId } from "../../e2e/hostFixtures/types";
import type { ResolvedHostContext } from "../harness/hostContexts";

/** Returns the asset names that every registered harness context can request. */
export function requiredDistAssets(
    contexts: readonly Pick<ResolvedHostContext, "scriptFile" | "styleFiles">[],
): readonly string[] {
    const assets = new Set<string>();
    for (const context of contexts) {
        assets.add(context.scriptFile);
        for (const styleFile of context.styleFiles) {
            assets.add(styleFile);
        }
    }
    return [...assets];
}

/** Returns required assets that are absent from a dist directory. */
export function missingDistAssets(
    distDir: string,
    requiredAssets: readonly string[],
    exists: (filePath: string) => boolean = fs.existsSync,
): readonly string[] {
    const root = path.resolve(distDir);
    return [...new Set(requiredAssets)].filter((asset) => !exists(path.join(root, asset)));
}

/** Throws with build guidance when a required production bundle is absent. */
export function assertRequiredDistAssets(
    distDir: string,
    requiredAssets: readonly string[],
    exists: (filePath: string) => boolean = fs.existsSync,
): void {
    const missing = missingDistAssets(distDir, requiredAssets, exists);
    if (missing.length === 0) return;

    const missingPaths = missing.map((asset) => path.join(path.resolve(distDir), asset));
    throw new Error(`Missing ${missingPaths.join(", ")}. Run: bun run build`);
}

/** Fails the harness teardown when any browser request escaped its in-process route. */
export function assertNoNetworkEscapes(networkEscapes: readonly string[]): void {
    if (networkEscapes.length > 0) {
        throw new Error(`Visual harness request escaped interceptor: ${networkEscapes.join(", ")}`);
    }
}

/** Resolves the host fixture encoded in a visual project's name. */
export function hostFixtureIdForProject(projectName: string): HostFixtureId {
    const knownFixtureIds: readonly HostFixtureId[] = [
        "dark-modern",
        "light-modern",
        "hc-black",
        "hc-light",
    ];
    const fixtureId = knownFixtureIds.find(
        (candidate) => projectName === candidate || projectName.startsWith(`${candidate}-`),
    );
    if (fixtureId === undefined) {
        throw new Error(`Visual project "${projectName}" does not identify a host fixture.`);
    }
    return fixtureId;
}

/** Resolves a safe on-disk dist asset for a `/dist/...` request path. */
export function resolveDistAssetPath(distDir: string, requestPath: string): string | undefined {
    let decodedPath = requestPath;
    try {
        // Decode repeatedly so double-encoded `..` segments cannot become traversal after the
        // first check. A bounded loop also prevents a malformed path from consuming the request.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const nextPath = decodeURIComponent(decodedPath);
            if (nextPath === decodedPath) break;
            decodedPath = nextPath;
        }
    } catch {
        return undefined;
    }

    if (!decodedPath.startsWith("/dist/")) return undefined;
    const assetName = decodedPath.slice("/dist/".length);
    if (assetName.length === 0 || assetName.includes("\0") || assetName.includes("\\")) {
        return undefined;
    }

    const root = path.resolve(distDir);
    const candidate = path.resolve(root, assetName);
    const relative = path.relative(root, candidate);
    if (
        relative.length === 0 ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        return undefined;
    }
    return candidate;
}
