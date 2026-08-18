import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const DEPENDABOT_PATH = resolve(__dirname, "../../../.github/dependabot.yml");
const PACKAGE_PATH = resolve(__dirname, "../../../package.json");

/**
 * Ecosystems that honour `dependency-type` inside a group, per the Dependabot options reference:
 * "Supported by: bundler, composer, mix, maven, npm, and pip."
 *
 * `bun` is deliberately absent. Whether Dependabot rejects the key there or quietly ignores it is
 * not something this repository can observe: its one runtime dependency is already at the newest
 * published version, so no grouped proposal has ever had the chance to show the selector either
 * including or excluding it. That is the reason to ban it rather than trust it -- an undocumented
 * selector whose effect cannot be measured is not one to build a production/development split on.
 */
const ECOSYSTEMS_SUPPORTING_DEPENDENCY_TYPE = new Set([
    "bundler",
    "composer",
    "mix",
    "maven",
    "npm",
    "pip",
]);

/** Every selector Dependabot documents inside a group. Anything else stops the read. */
const GROUP_KEYS = new Set([
    "applies-to",
    "dependency-type",
    "patterns",
    "exclude-patterns",
    "update-types",
]);

interface DependabotGroup {
    readonly patterns: readonly string[];
    readonly excludePatterns: readonly string[];
    readonly selectorKeys: readonly string[];
}

interface DependabotEcosystem {
    readonly name: string;
    readonly groups: ReadonlyMap<string, DependabotGroup>;
}

/**
 * Reads the `groups:` blocks out of dependabot.yml by indentation.
 *
 * Deliberately narrow: any line inside a group that this reader does not recognise throws rather
 * than being skipped. A selector these tests cannot see is a selector they cannot vouch for, and
 * silently ignoring one is exactly how `dependency-type` survived two pull requests.
 */
function readEcosystems(): readonly DependabotEcosystem[] {
    const lines = readFileSync(DEPENDABOT_PATH, "utf8").split("\n");
    const ecosystems: DependabotEcosystem[] = [];
    let groups: Map<string, DependabotGroup> | undefined;
    let group:
        | { patterns: string[]; excludePatterns: string[]; selectorKeys: string[] }
        | undefined;
    let listTarget: string[] | undefined;
    let inGroups = false;

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (line === "" || /^\s*#/.test(line)) continue;

        const ecosystem = line.match(/^ {4}- package-ecosystem:\s*(\S+)$/);
        if (ecosystem) {
            groups = new Map();
            group = undefined;
            listTarget = undefined;
            inGroups = false;
            ecosystems.push({ name: ecosystem[1], groups });
            continue;
        }
        if (!groups) continue;

        if (/^ {6}groups:$/.test(line)) {
            inGroups = true;
            continue;
        }
        // Any other key at the ecosystem's own indent ends the groups block.
        if (/^ {6}\S/.test(line)) {
            inGroups = false;
            group = undefined;
            listTarget = undefined;
            continue;
        }
        if (!inGroups) continue;

        const named = line.match(/^ {10}(\S+):$/);
        if (named) {
            group = { patterns: [], excludePatterns: [], selectorKeys: [] };
            listTarget = undefined;
            groups.set(named[1], group);
            continue;
        }
        if (!group) throw new Error(`group key outside any named group: ${line}`);

        const item = line.match(/^ {18}- (.+)$/);
        if (item) {
            if (!listTarget) throw new Error(`list item outside any list: ${line}`);
            listTarget.push(item[1].replace(/^["']|["']$/g, ""));
            continue;
        }

        const key = line.match(/^ {14}([a-z-]+):(.*)$/);
        if (!key) throw new Error(`unrecognised line inside a dependabot group: ${line}`);
        const [, name, rest] = key;
        // Allowlisted, not merely shaped like a key: `[a-z-]+` accepts anything lowercase, so a
        // selector nobody here has considered would be recorded and then ignored -- the same silent
        // pass that let `dependency-type` through twice.
        if (!GROUP_KEYS.has(name))
            throw new Error(`unrecognised dependabot group selector: ${name}`);
        group.selectorKeys.push(name);
        listTarget =
            name === "patterns"
                ? group.patterns
                : name === "exclude-patterns"
                  ? group.excludePatterns
                  : undefined;
        if (listTarget && rest.trim() !== "") throw new Error(`inline list not supported: ${line}`);
    }
    return ecosystems;
}

function runtimeDependencyNames(): readonly string[] {
    const manifest = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as {
        dependencies?: Record<string, string>;
    };
    return Object.keys(manifest.dependencies ?? {}).sort();
}

describe("dependabot grouping", () => {
    it("never selects on dependency-type in an ecosystem that ignores it", () => {
        const offenders = readEcosystems().flatMap((ecosystem) =>
            ECOSYSTEMS_SUPPORTING_DEPENDENCY_TYPE.has(ecosystem.name)
                ? []
                : [...ecosystem.groups]
                      .filter(([, group]) => group.selectorKeys.includes("dependency-type"))
                      .map(([name]) => `${ecosystem.name}/${name}`),
        );
        expect(
            offenders,
            "dependency-type is honoured only by bundler, composer, mix, maven, npm and pip; " +
                "elsewhere it selects nothing and the group quietly stops matching what it names",
        ).toEqual([]);
    });

    it("keeps the production group naming exactly the dependencies that ship to users", () => {
        const bun = readEcosystems().find((ecosystem) => ecosystem.name === "bun");
        const patterns = bun?.groups.get("production-dependencies")?.patterns ?? [];
        // Set equality both ways: a runtime dependency added to package.json and left out here would
        // be grouped as development, and a name left here after its dependency is dropped would
        // match nothing at all. Neither shows up as a failure anywhere else.
        expect([...patterns].sort()).toEqual(runtimeDependencyNames());
    });

    it("keeps every runtime dependency out of the development group", () => {
        const bun = readEcosystems().find((ecosystem) => ecosystem.name === "bun");
        const development = bun?.groups.get("safe-development-dependencies");
        expect(development?.patterns).toEqual(["*"]);
        // `*` matches the runtime dependency too, so without the exclusion both groups claim it and
        // the split it exists to provide is gone.
        expect([...(development?.excludePatterns ?? [])].sort()).toEqual(runtimeDependencyNames());
    });
});
