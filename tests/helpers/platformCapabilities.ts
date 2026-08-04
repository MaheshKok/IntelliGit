import { spawnSync } from "node:child_process";

/** Whether this runtime can execute the POSIX-shell contracts used by shell-dependent tests. */
export const supportsPosixShell =
    process.platform !== "win32" &&
    spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;

/** Whether chmod can make a fixture unreadable for the current test process. */
export const supportsUnreadableDirectories =
    process.platform !== "win32" && process.getuid?.() !== 0;
