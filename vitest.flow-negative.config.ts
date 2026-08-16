import { defineConfig } from "vitest/config";

/** Opt-in Vitest project for the expected-failure four-way flow oracle fixture. */
export default defineConfig({
    test: {
        include: ["tests/e2e/flows/negative/leg.negative.ts"],
        globals: true,
        testTimeout: 180_000,
        hookTimeout: 30_000,
    },
});
