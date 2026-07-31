import React from "react";
import { IconButton, Tooltip } from "@chakra-ui/react";
import { getSettings } from "../settings";

interface ToolbarIconButtonProps {
    label: string;
    icon: React.ReactElement<{
        "aria-hidden"?: boolean;
        focusable?: string | boolean;
        style?: React.CSSProperties;
    }>;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    pressed?: boolean;
    spin?: boolean;
    color?: string;
}

/**
 * Disabled glyph tint. `--vscode-disabledForeground` is already translucent
 * (`#CCCCCC80` in Dark+), so it must not be dimmed a second time by an opacity
 * layer or the control disappears instead of reading as disabled.
 */
export const DISABLED_GLYPH_COLOR = "var(--vscode-disabledForeground, rgba(214, 219, 229, 0.55))";

/**
 * Shared 24px toolbar icon button used by the commit, stash, and shelf toolbars.
 *
 * One geometry everywhere: the `toolbarGhost` variant supplies the 24×24 hit
 * target and 4px radius, so every panel toolbar reads as the same control.
 */
export function ToolbarIconButton({
    label,
    icon,
    onClick,
    disabled,
    pressed,
    spin,
    color,
}: ToolbarIconButtonProps): React.ReactElement {
    const { hoverDelay, tooltipsEnabled, iconStyle } = getSettings();
    const resolvedColor = spin
        ? (color ?? "var(--vscode-icon-foreground)")
        : disabled
          ? DISABLED_GLYPH_COLOR
          : iconStyle === "standard"
            ? "var(--vscode-icon-foreground)"
            : (color ?? "var(--vscode-icon-foreground)");
    const glyphStyle: React.CSSProperties = {
        color: resolvedColor,
        ...(spin
            ? {
                  animation: "intelligit-spin 0.8s linear infinite",
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  willChange: "transform",
              }
            : {}),
    };
    const renderedIcon = React.cloneElement(icon, {
        "aria-hidden": true,
        focusable: "false",
        style: { ...glyphStyle, ...(icon.props.style ?? {}) },
    });

    return (
        <Tooltip
            label={label}
            fontSize="11px"
            placement="bottom"
            openDelay={hoverDelay}
            isDisabled={!tooltipsEnabled}
        >
            <IconButton
                aria-label={label}
                aria-pressed={pressed}
                variant="toolbarGhost"
                size="sm"
                onClick={disabled ? undefined : onClick}
                isDisabled={disabled}
                _disabled={{
                    bg: "rgba(255,255,255,0.03)",
                    color: DISABLED_GLYPH_COLOR,
                    cursor: "default",
                    opacity: 1,
                }}
                data-refreshing={spin ? "true" : undefined}
                icon={renderedIcon}
            />
        </Tooltip>
    );
}
