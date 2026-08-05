// Blue refresh control for the Shelf and Stash toolbars, matching the spinning
// icon the Commit toolbar already shows.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { IconButton, Tooltip } from "@chakra-ui/react";
import { VscRefresh } from "react-icons/vsc";
import { getSettings, resolveIconColor } from "../settings";
import { ICON_ACCENTS } from "../tokens";
import { t } from "../i18n";
import { SPIN_KEYFRAMES } from "./iconStyles";

/** Keeps a refresh that finishes instantly on screen long enough to be read. */
const MIN_SPIN_MS = 700;

interface RefreshButtonProps {
    /** Host refresh state; a click spins too, in case the host finishes first. */
    isRefreshing: boolean;
    /**
     * Keeps feedback visible after a click or completed host refresh. Defaults to
     * `true` for undocked toolbars whose hosts can finish before the next paint.
     */
    holdFeedback?: boolean;
    onRefresh: () => void;
}

/** Refresh icon shared by the shelf and stash toolbars. */
export function RefreshButton({
    isRefreshing,
    holdFeedback = true,
    onRefresh,
}: RefreshButtonProps): React.ReactElement {
    const { hoverDelay, tooltipsEnabled } = getSettings();
    const [isSpinHeld, setIsSpinHeld] = useState(false);
    const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wasRefreshingRef = useRef<boolean | undefined>(undefined);

    // Each request restarts the tail, so a click landing mid-tail extends it instead of
    // inheriting the leftover of the previous one.
    const holdSpin = useCallback(() => {
        if (!holdFeedback) return;
        setIsSpinHeld(true);
        if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
        holdTimerRef.current = setTimeout(() => {
            holdTimerRef.current = null;
            setIsSpinHeld(false);
        }, MIN_SPIN_MS);
    }, [holdFeedback]);

    // A host-driven refresh can finish within a frame or two — the undocked window does
    // not pad its refresh span the way the docked panel does — so the spin gets its own
    // tail when the host's flag drops.
    useEffect(() => {
        const wasRefreshing = wasRefreshingRef.current;
        wasRefreshingRef.current = isRefreshing;
        // react-doctor-disable-next-line react-doctor/no-derived-state, react-doctor/no-event-handler -- The host's falling edge can happen before paint, so it must start this independent 700ms visual tail without replaying `onRefresh`.
        if (wasRefreshing === true && !isRefreshing) holdSpin();
    }, [holdSpin, isRefreshing]);

    useEffect(
        () => () => {
            if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
        },
        [],
    );

    const handleClick = useCallback(() => {
        holdSpin();
        onRefresh();
    }, [holdSpin, onRefresh]);

    const spin = isRefreshing || (holdFeedback && isSpinHeld);
    const label = spin ? t("common.refreshing") : t("common.refresh");
    // Spinning is the "working" signal, so the glyph keeps its accent color instead of
    // fading to the disabled grey — a refresh in progress has to read louder than an
    // idle one, not quieter.
    const iconStyle: React.CSSProperties = {
        color: resolveIconColor(ICON_ACCENTS.cyan, "var(--vscode-icon-foreground)"),
        ...(spin
            ? {
                  animation: "intelligit-spin 0.8s linear infinite",
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  willChange: "transform",
              }
            : {}),
    };

    return (
        <>
            {spin && <style>{SPIN_KEYFRAMES}</style>}
            <Tooltip
                label={label}
                fontSize="11px"
                placement="bottom"
                openDelay={hoverDelay}
                isDisabled={!tooltipsEnabled}
            >
                <IconButton
                    aria-label={label}
                    data-testid="refresh-button"
                    variant="toolbarGhost"
                    size="xs"
                    onClick={spin ? undefined : handleClick}
                    isDisabled={spin}
                    _disabled={{
                        bg: "rgba(255,255,255,0.03)",
                        cursor: "default",
                        opacity: 1,
                    }}
                    data-refreshing={spin ? "true" : undefined}
                    icon={<VscRefresh size={16} aria-hidden focusable="false" style={iconStyle} />}
                />
            </Tooltip>
        </>
    );
}
