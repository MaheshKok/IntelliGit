import * as durableState from "./e2e/oracles/durableState";
import * as gitEnv from "./e2e/oracles/gitEnv";
import * as localGit from "./e2e/oracles/localGit";
import * as origin from "./e2e/oracles/origin";
import * as accessibleNameVerdict from "./visual/oracles/accessibleNameVerdict";
import * as catalogSources from "./visual/oracles/catalogSources";
import * as contrast from "./visual/oracles/contrast";
import * as findingsBaseline from "./visual/oracles/findingsBaseline";
import * as findingsBaselineFile from "./visual/oracles/findingsBaselineFile";
import * as geometry from "./visual/oracles/geometry";
import * as pinnedBaseImage from "./visual/oracles/pinnedBaseImage";
import * as pixelAssertionPlan from "./visual/oracles/pixelAssertionPlan";
import * as truncationSources from "./visual/oracles/truncationSources";
import * as visualEnvironment from "./visual/oracles/visualEnvironment";

// Every module in every `oracles/` directory is registered deliberately; do not curate exports.
const ORACLES = {
    accessibleNameVerdict,
    catalogSources,
    contrast,
    findingsBaseline,
    findingsBaselineFile,
    geometry,
    pinnedBaseImage,
    pixelAssertionPlan,
    truncationSources,
    visualEnvironment,
    durableState,
    gitEnv,
    localGit,
    origin,
};

export type OracleId = keyof typeof ORACLES;

/** The registered oracle module basenames used by registry contract tests. */
export const ORACLE_IDS: OracleId[] = Object.keys(ORACLES) as OracleId[];

/** Returns the registered oracle namespace for the requested module basename. */
function get<K extends keyof typeof ORACLES>(id: K): (typeof ORACLES)[K] {
    return ORACLES[id];
}

/** Facade for resolving registered oracle namespaces by module basename. */
export const oracles = { get };
