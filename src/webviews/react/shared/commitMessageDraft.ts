/**
 * Builds the buffer a commit-message generation run streams into.
 *
 * Generation appends below whatever the user already typed, so the run starts
 * from the existing draft plus a line break instead of an empty message. A
 * blank or whitespace-only draft contributes nothing, keeping the generated
 * message flush with the top of the input.
 */
export function commitMessageGenerationPrefix(draft: string): string {
    const kept = draft.replace(/\s+$/u, "");
    return kept ? `${kept}\n` : "";
}
