import React from "react";
import { Button, IconButton, Tooltip } from "@chakra-ui/react";
import { getSettings } from "../settings";

type Presentation = "toolbar" | "stash" | "shelf";

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
    /** Preserves each existing toolbar's intentionally distinct button geometry. */
    presentation?: Presentation;
}

/** Shared tooltip and icon-button behavior for the commit, stash, and shelf toolbars. */
export function ToolbarIconButton({
    label,
    icon,
    onClick,
    disabled,
    pressed,
    spin,
    color,
    presentation = "toolbar",
}: ToolbarIconButtonProps): React.ReactElement {
    const { hoverDelay, tooltipsEnabled, iconStyle } = getSettings();
    const isToolbar = presentation === "toolbar";
    const resolvedColor = isToolbar
        ? disabled
            ? "var(--vscode-disabledForeground)"
            : iconStyle === "standard"
              ? "var(--vscode-icon-foreground)"
              : (color ?? undefined)
        : presentation === "stash"
          ? "var(--vscode-icon-foreground)"
          : undefined;
    const glyphStyle: React.CSSProperties = {
        ...(resolvedColor ? { color: resolvedColor } : {}),
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
    const buttonProps = {
        "aria-label": label,
        "aria-pressed": pressed,
        variant: "toolbarGhost" as const,
        onClick: disabled ? undefined : onClick,
        isDisabled: disabled,
        ...(isToolbar
            ? {
                  _disabled: {
                      bg: "rgba(255,255,255,0.03)",
                      color: "var(--vscode-disabledForeground)",
                      cursor: "default",
                      opacity: 0.55,
                  },
                  "data-refreshing": spin ? "true" : undefined,
              }
            : {}),
    };
    const button =
        presentation === "shelf" ? (
            <Button {...buttonProps} size="xs">
                {renderedIcon}
            </Button>
        ) : (
            <IconButton
                {...buttonProps}
                icon={renderedIcon}
                size="sm"
                {...(presentation === "stash" ? { minW: "26px", h: "26px" } : {})}
            />
        );

    return (
        <Tooltip
            label={label}
            fontSize="11px"
            {...(isToolbar ? { placement: "bottom" as const } : {})}
            openDelay={hoverDelay}
            isDisabled={!tooltipsEnabled}
        >
            {button}
        </Tooltip>
    );
}
