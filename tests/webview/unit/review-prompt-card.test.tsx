// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewPromptCard } from "../../../src/webviews/react/shared/components/ReviewPromptCard";
import theme from "../../../src/webviews/react/commit-panel/theme";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";

initReactDomTestEnvironment();

function renderCard() {
    const onAnswer = vi.fn();
    const { container } = mount(
        <ChakraProvider theme={theme}>
            <ReviewPromptCard onAnswer={onAnswer} />
        </ChakraProvider>,
    );
    return { container, onAnswer };
}

function click(container: ParentNode, selector: string): void {
    const element = container.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing element for ${selector}`);
    act(() => {
        element.click();
    });
}

function button(container: ParentNode, text: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    if (!match) throw new Error(`Missing "${text}" button`);
    return match as HTMLButtonElement;
}

function star(container: ParentNode, rating: number): string {
    return `[role="radio"]:nth-of-type(${rating})`;
}

describe("ReviewPromptCard", () => {
    it("offers five unrated stars before any answer", () => {
        const { container, onAnswer } = renderCard();

        const stars = container.querySelectorAll('[role="radio"]');
        expect(stars).toHaveLength(5);
        expect([...stars].every((s) => s.getAttribute("aria-checked") === "false")).toBe(true);
        expect(onAnswer).not.toHaveBeenCalled();
    });

    it("routes a high rating to the marketplace", () => {
        const { container, onAnswer } = renderCard();

        click(container, star(container, 5));
        act(() => {
            button(container, "Rate IntelliGit").click();
        });

        expect(onAnswer).toHaveBeenCalledWith({ decision: "rated", open: "marketplace" });
    });

    it("keeps a high rating terminal even when the user declines to post it", () => {
        const { container, onAnswer } = renderCard();

        click(container, star(container, 4));
        act(() => {
            button(container, "Not now").click();
        });

        expect(onAnswer).toHaveBeenCalledWith({ decision: "rated" });
    });

    it("leads a low rating to feedback", () => {
        const { container, onAnswer } = renderCard();

        click(container, star(container, 2));
        act(() => {
            button(container, "Report an issue").click();
        });

        expect(onAnswer).toHaveBeenCalledWith({ decision: "declined", open: "feedback" });
    });

    it("still offers a low rating the public review page", () => {
        const { container, onAnswer } = renderCard();

        click(container, star(container, 1));
        const link = container.querySelector<HTMLElement>(".review-prompt-link");
        expect(link).not.toBeNull();
        act(() => {
            link?.click();
        });

        expect(onAnswer).toHaveBeenCalledWith({ decision: "declined", open: "marketplace" });
    });

    it("treats three stars as the low branch", () => {
        const { container } = renderCard();

        click(container, star(container, 3));

        expect(container.querySelector(".review-prompt-link")).not.toBeNull();
    });

    it("defers without a decision on Later and on Escape", () => {
        const { container, onAnswer } = renderCard();

        act(() => {
            button(container, "Later").click();
        });
        expect(onAnswer).toHaveBeenCalledWith({ decision: "later" });

        const backdrop = container.querySelector<HTMLElement>('[role="presentation"]');
        act(() => {
            backdrop?.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
            );
        });
        expect(onAnswer).toHaveBeenLastCalledWith({ decision: "later" });
    });

    it("declines outright without opening anything", () => {
        const { container, onAnswer } = renderCard();

        act(() => {
            button(container, "Don't ask again").click();
        });

        expect(onAnswer).toHaveBeenCalledWith({ decision: "declined" });
    });
});
