let observer: IntersectionObserver | undefined;
const callbacks = new WeakMap<Element, () => void>();
let observed = 0;

/** One browser observer serves all trees, including nonvirtual groups below the fold. */
export function observeVisibleRow(element: Element, visible: () => void): () => void {
    if (typeof IntersectionObserver === "undefined") return () => undefined;
    observer ??= new IntersectionObserver(
        (entries) => {
            for (const entry of entries) if (entry.isIntersecting) callbacks.get(entry.target)?.();
        },
        { rootMargin: "96px 0px" },
    );
    callbacks.set(element, visible);
    observed++;
    observer.observe(element);
    let watching = true;
    return () => {
        if (!watching) return;
        watching = false;
        callbacks.delete(element);
        observer?.unobserve(element);
        observed--;
        if (!observed) {
            observer?.disconnect();
            observer = undefined;
        }
    };
}
