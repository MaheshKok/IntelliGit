// @vitest-environment jsdom
import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { initReactDomTestEnvironment, mount } from "../../helpers/reactDomTestUtils";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => ({ postMessage }),
}));
vi.mock("../../../src/webviews/react/shared/i18n", () => ({
    t: (key: string) =>
        (({ title: "Git Remotes", defineRemote: "Define Remote" }) as Record<string, string>)[
            key.split(".").at(-1)!
        ] ?? key.split(".").at(-1),
}));

import { ManageRemotesApp } from "../../../src/webviews/react/manage-remotes/ManageRemotesApp";

initReactDomTestEnvironment();

function send(data: unknown) {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data }));
    });
}

function click(element: Element | null) {
    expect(element).not.toBeNull();
    act(() => {
        (element as HTMLElement).click();
    });
}

function input(element: Element | null, value: string) {
    expect(element).not.toBeNull();
    act(() => {
        const field = element as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            field,
            value,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

function setup(remotes: Array<{ name: string; url: string; additionalUrlCount: number }> = []) {
    const { container } = mount(<ManageRemotesApp />);
    send({ type: "snapshot", repoLabel: "/repo-b", revision: 2, remotes });
    return container;
}

describe("Git Remotes dialog", () => {
    it("shows an empty table and opens Define Remote with Add available", () => {
        const container = setup();
        expect(container.textContent).toContain("Git Remotes");
        expect(container.textContent).toContain("empty");
        click(container.querySelector('[aria-label="add"]'));
        expect(container.textContent).toContain("Define Remote");
        expect(container.querySelector('input[name="name"]')).not.toBeNull();
        expect(container.querySelector('input[name="url"]')).not.toBeNull();
        expect(document.activeElement).toBe(container.querySelector('input[name="name"]'));
    });

    it("selects a row, pre-fills Edit, and posts name plus configured URL", () => {
        const container = setup([{ name: "origin", url: "alias:repo.git", additionalUrlCount: 1 }]);
        expect((container.querySelector('[aria-label="edit"]') as HTMLButtonElement).disabled).toBe(
            true,
        );
        click(container.querySelector('[role="row"][data-remote="origin"]'));
        click(container.querySelector('[aria-label="edit"]'));
        expect((container.querySelector('input[name="name"]') as HTMLInputElement).value).toBe(
            "origin",
        );
        expect((container.querySelector('input[name="url"]') as HTMLInputElement).value).toBe(
            "alias:repo.git",
        );
        expect(container.textContent).toContain("additionalUrls");
        input(container.querySelector('input[name="name"]'), "upstream");
        input(container.querySelector('input[name="url"]'), "../new repo.git");
        click(container.querySelector('button[type="submit"]'));
        expect(postMessage).toHaveBeenCalledWith({
            type: "edit",
            revision: 2,
            originalName: "origin",
            name: "upstream",
            url: "../new repo.git",
        });
    });

    it("cancels on Escape, restores focus and performs no mutation", () => {
        const container = setup();
        const add = container.querySelector('[aria-label="add"]') as HTMLButtonElement;
        click(add);
        act(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(container.textContent).not.toContain("Define Remote");
        expect(document.activeElement).toBe(add);
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "add" }));
    });

    it("keeps host errors visible with Retry and treats hostile URL text as text", () => {
        const payload = "<img src=x onerror=alert(1)>";
        const container = setup([{ name: "origin", url: payload, additionalUrlCount: 0 }]);
        expect(container.querySelector("img")).toBeNull();
        expect(container.textContent).toContain(payload);
        send({ type: "error", message: "config unreadable" });
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
            "config unreadable",
        );
        click(container.querySelector('[aria-label="retry"]'));
        expect(postMessage).toHaveBeenCalledWith({ type: "reload" });
    });

    it("does not offer Add before a successful authoritative snapshot", () => {
        const { container } = mount(<ManageRemotesApp />);
        send({ type: "error", message: "config unreadable" });
        expect((container.querySelector('[aria-label="add"]') as HTMLButtonElement).disabled).toBe(
            true,
        );
        expect(container.querySelector('[aria-label="retry"]')).not.toBeNull();
    });

    it("closes an old form when a newer snapshot supersedes its selected URL", () => {
        const container = setup([{ name: "origin", url: "../old.git", additionalUrlCount: 0 }]);
        click(container.querySelector('[data-remote="origin"]'));
        click(container.querySelector('[aria-label="edit"]'));
        input(container.querySelector('input[name="url"]'), "../mine.git");
        send({
            type: "snapshot",
            repoLabel: "/repo-b",
            revision: 3,
            remotes: [{ name: "origin", url: "../external.git", additionalUrlCount: 0 }],
        });
        expect(container.querySelector('input[name="url"]')).toBeNull();
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("staleForm");
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "edit" }));
    });
});
