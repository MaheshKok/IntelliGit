import type { NativeCommitInputBridge } from "../../src/views/nativeCommitInputBridge";

export function createNoopNativeCommitInputBridge(): Pick<
    NativeCommitInputBridge,
    "attach" | "detach" | "setFromPanel" | "setVisible" | "dispose"
> {
    return {
        attach: (): void => {},
        detach: (): void => {},
        setFromPanel: (): void => {},
        setVisible: (): void => {},
        dispose: (): void => {},
    };
}
