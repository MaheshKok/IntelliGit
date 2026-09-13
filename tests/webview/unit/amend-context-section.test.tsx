// @vitest-environment jsdom

import React from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import { AmendContextSection } from "../../../src/webviews/react/commit-panel/components/AmendContextSection";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { flush, initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";

initReactDomTestEnvironment();

describe("AmendContextSection", () => {
    it("uses full commit identities when displayed abbreviations collide", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const { container } = mount(
                <ChakraProvider theme={theme}>
                    <AmendContextSection
                        historyLoaded
                        commits={[
                            {
                                hash: "deadbee".padEnd(40, "1"),
                                shortHash: "deadbee",
                                subject: "first",
                                date: "2024-01-01T00:00:00Z",
                            },
                            {
                                hash: "deadbee".padEnd(40, "2"),
                                shortHash: "deadbee",
                                subject: "second",
                                date: "2024-01-02T00:00:00Z",
                            },
                        ]}
                    />
                </ChakraProvider>,
            );
            await flush();

            expect(container.textContent).toContain("first");
            expect(container.textContent).toContain("second");
            expect(
                consoleError.mock.calls.some((call) =>
                    call.some((value) => String(value).includes("same key")),
                ),
            ).toBe(false);
        } finally {
            consoleError.mockRestore();
        }
    });
});
