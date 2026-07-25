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

    useEffect(
        () => () => {
            if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
        },
        [],
    );

    const handleClick = useCallback(() => {
        if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
        setIsSpinHeld(true);
        holdTimerRef.current = setTimeout(() => {
            setIsSpinHeld(false);
            holdTimerRef.current = undefined;
        }, MIN_SPIN_MS);
        onRefresh();
    }, [onRefresh]);

    const spin = isRefreshing || isSpinHeld;
    const label = spin ? t("common.refreshing") : t("common.refresh");
    const iconStyle: React.CSSProperties = {
        color: spin
            ? "var(--vscode-disabledForeground)"
            : resolveIconColor("#4ec7d6", "var(--vscode-icon-foreground)"),
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
                        color: "var(--vscode-disabledForeground)",
                        cursor: "default",
                        opacity: 0.55,
                    }}
                    data-refreshing={spin ? "true" : undefined}
                    icon={<IoMdRefresh size={16} aria-hidden focusable="false" style={iconStyle} />}
                />
            </Tooltip>
        </>
    );
}
