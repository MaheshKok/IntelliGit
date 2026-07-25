// Blue refresh control for the Shelf and Stash toolbars, matching the spinning
// icon the Commit toolbar already shows.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { IconButton, Tooltip } from "@chakra-ui/react";
import { IoMdRefresh } from "react-icons/io";
import { getSettings, resolveIconColor } from "../settings";
import { t } from "../i18n";

const SPIN_KEYFRAMES = `@keyframes intelligit-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;

/** Keeps a refresh that finishes instantly on screen long enough to be read. */
const MIN_SPIN_MS = 700;

interface RefreshButtonProps {
    /** Host refresh state; a click spins too, in case the host finishes first. */
    isRefreshing: boolean;
    onRefresh: () => void;
}

/** Refresh icon shared by the shelf and stash toolbars. */
export function RefreshButton({ isRefreshing, onRefresh }: RefreshButtonProps): React.ReactElement {
    const { hoverDelay, tooltipsEnabled } = getSettings();
    const [isSpinHeld, setIsSpinHeld] = useState(false);
    const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const holdSpin = useCallback(() => {
        if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
        setIsSpinHeld(true);
        holdTimerRef.current = setTimeout(() => {
            setIsSpinHeld(false);
            holdTimerRef.current = undefined;
        }, MIN_SPIN_MS);
    }, []);

    useEffect(
        () => () => {
            if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
        },
        [],
    );

    // A host-driven refresh can finish within a frame or two — the undocked window does
    // not pad its refresh span the way the docked panel does — so a host refresh holds
    // the spin exactly like a click does.
    useEffect(() => {
        if (isRefreshing) holdSpin();
    }, [holdSpin, isRefreshing]);

    const handleClick = useCallback(() => {
        holdSpin();
        onRefresh();
    }, [holdSpin, onRefresh]);

    const spin = isRefreshing || isSpinHeld;
    const label = spin ? t("common.refreshing") : t("common.refresh");
    // Spinning is the "working" signal, so the glyph keeps its accent color instead of
    // fading to the disabled grey — a refresh in progress has to read louder than an
    // idle one, not quieter.
    const iconStyle: React.CSSProperties = {
        color: resolveIconColor("#4ec7d6", "var(--vscode-icon-foreground)"),
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
                    minW="26px"
                    h="26px"
                    onClick={spin ? undefined : handleClick}
                    isDisabled={spin}
                    _disabled={{
                        bg: "rgba(255,255,255,0.03)",
                        cursor: "default",
                        opacity: 1,
                    }}
                    data-refreshing={spin ? "true" : undefined}
                    icon={<IoMdRefresh size={16} aria-hidden focusable="false" style={iconStyle} />}
                />
            </Tooltip>
        </>
    );
}
