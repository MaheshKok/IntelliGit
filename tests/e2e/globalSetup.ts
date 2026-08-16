// Ensures the pinned VS Code build exists BEFORE any test's clock starts.
//
// The download is ~305 MB. Left inside a test body it competes with that
// test's timeout for the same budget, so the very first run on a clean
// machine -- every CI runner with a cold cache, and every new contributor --
// fails with a timeout that looks exactly like a hung Electron launch while
// actually being a perfectly healthy download. That is a misleading failure,
// and it is worse than a slow one.
//
// `globalSetup` runs once in the runner process, before the first test, and
// is bounded by `globalTimeout` rather than by any per-test timeout. So the
// download gets its own budget, every test then finds the binary already
// cached, and a per-test timeout goes back to meaning what it should: the
// app under test hung.

import path from "node:path";
import { resolveVSCodeExecutable } from "./hostFixtures/resolveVSCodeExecutable";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

export default async function globalSetup(): Promise<void> {
    const executablePath = await resolveVSCodeExecutable(REPO_ROOT);
    console.log(`[e2e globalSetup] VS Code ready at ${executablePath}`);
}
