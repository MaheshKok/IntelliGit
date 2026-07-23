// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkingFile } from "../../../src/types";
import { ShelveDialog } from "../../../src/webviews/react/commit-panel/components/ShelveDialog";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";

initReactDomTestEnvironment();

const files: WorkingFile[] = [
    { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
    { path: "src/b.ts", status: "A", staged: false, additions: 1, deletions: 0 },
];

function click(element: Element): void {
    act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function setValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing native input setter");
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

describe("ShelveDialog", () => {
    it("keeps the supplied draft name verbatim and submits per-file selection", () => {
        const onSubmit = vi.fn();
        const { root, container } = mount(
            <ChakraProvider theme={theme}>
                <ShelveDialog
                    files={files}
                    defaultName="  draft name  "
                    selectedPaths={["src/a.ts"]}
                    onClose={vi.fn()}
                    onSubmit={onSubmit}
                />
            </ChakraProvider>,
        );
        const name = container.querySelector('input[aria-label="Shelf name"]') as HTMLInputElement;
        const first = container.querySelector('input[aria-label="src/a.ts"]') as HTMLInputElement;
        const second = container.querySelector('input[aria-label="src/b.ts"]') as HTMLInputElement;
        const submit = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent === "Shelve Changes",
        ) as HTMLButtonElement;

        expect(name.value).toBe("  draft name  ");
        expect(first.checked).toBe(true);
        expect(second.checked).toBe(false);
        click(second);
        setValue(name, "  host validates this  ");
        click(submit);
        expect(onSubmit).toHaveBeenCalledWith({
            name: "  host validates this  ",
            paths: ["src/a.ts", "src/b.ts"],
        });

        unmount(root, container);
    });
});
