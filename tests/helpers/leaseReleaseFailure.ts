import { vi } from "vitest";
import { ChangelistPersistence } from "../../src/changes/changelistPersistence";

/**
 * The next durable metadata lock frees itself for real on release and then rejects, so the target
 * operation lease built on it fails to release without leaving the lock held. The handle is frozen
 * and identity-checked, so the failure is injected below it. `logged` records `console.error`.
 */
export function failNextLeaseRelease() {
    const failure = new Error("Injected lease release failure");
    const acquire = ChangelistPersistence.prototype.acquire;
    vi.spyOn(ChangelistPersistence.prototype, "acquire").mockImplementationOnce(async function (
        this: ChangelistPersistence,
    ) {
        const release = await acquire.call(this);
        return async () => {
            await release();
            throw failure;
        };
    });
    return { failure, logged: vi.spyOn(console, "error").mockImplementation(() => undefined) };
}
