import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import type { ReviewPromptDecision, ReviewPromptTarget } from "../../../protocol/commitGraphTypes";
import { t } from "../i18n";
import { JETBRAINS_UI, TYPE_SCALE, Z_INDEX } from "../tokens";
import "./ReviewPromptCard.css";

/** Ratings at or above this go straight to the marketplace; below it, the card asks what is wrong. */
const HAPPY_THRESHOLD = 4;
const STARS: readonly number[] = [1, 2, 3, 4, 5];

/** One answer to the card, mirroring the host-side review prompt result. */
export interface ReviewPromptAnswer {
    decision: ReviewPromptDecision;
    open?: ReviewPromptTarget;
}

/** Props for {@link ReviewPromptCard}. */
export interface ReviewPromptCardProps {
    /** Receives exactly one answer; the host closes the card on the first call. */
    onAnswer: (answer: ReviewPromptAnswer) => void;
}

/**
 * Centered rating card shown in place of the marketplace notification.
 *
 * Stars cannot be submitted to either marketplace — neither has a write API — so a star
 * click can only send the user somewhere. A happy click therefore opens the marketplace
 * itself rather than a second button that does the same thing: the star already carried
 * the whole answer, and a confirmation step reads as if the rating went nowhere (which,
 * silently, it did). A low rating is the one case that still needs a question, because
 * "what is wrong" and "post it publicly anyway" are genuinely different routes.
 *
 * Every star click is terminal either way: an answered user is never asked again.
 */
export function ReviewPromptCard({ onAnswer }: ReviewPromptCardProps): React.ReactElement {
    const [rating, setRating] = useState<number>();
    const [hovered, setHovered] = useState<number>();
    const dismissRef = useRef<HTMLButtonElement>(null);
    // The Escape handler sits on the backdrop, so it only ever fires once focus is inside
    // the card. Moving focus here on mount is what makes the card dismissible by keyboard.
    useEffect(() => {
        dismissRef.current?.focus();
    }, []);

    const later = useCallback(() => onAnswer({ decision: "later" }), [onAnswer]);
    // A set `rating` is always a low one: a happy click answers and closes the card outright.
    const rate = useCallback(
        (star: number) =>
            star >= HAPPY_THRESHOLD
                ? onAnswer({ decision: "rated", open: "marketplace" })
                : setRating(star),
        [onAnswer],
    );

    return (
        <Flex
            role="presentation"
            position="fixed"
            inset={0}
            zIndex={Z_INDEX.modal}
            align="center"
            justify="center"
            bg="rgba(0, 0, 0, 0.45)"
            onMouseDown={(event) => event.currentTarget === event.target && later()}
            onKeyDown={(event) => event.key === "Escape" && later()}
        >
            <Flex
                role="dialog"
                aria-modal="true"
                aria-labelledby="review-prompt-title"
                tabIndex={-1}
                direction="column"
                align="center"
                gap="10px"
                w="min(380px, calc(100vw - 32px))"
                p="20px"
                textAlign="center"
                border="1px solid var(--intelligit-pycharm-border)"
                borderRadius={`${JETBRAINS_UI.size.floatingRadius}px`}
                bg="var(--intelligit-pycharm-panel)"
                color="var(--intelligit-pycharm-foreground)"
                boxShadow="0 8px 32px rgba(0, 0, 0, 0.32)"
            >
                <Box
                    as="h2"
                    id="review-prompt-title"
                    fontSize={`${TYPE_SCALE.dialogTitle}px`}
                    fontWeight={600}
                >
                    {rating === undefined ? t("review.card.title") : t("review.card.unhappyTitle")}
                </Box>
                <Box fontSize="12px" opacity={0.85}>
                    {rating === undefined
                        ? t("review.card.subtitle")
                        : t("review.card.unhappyBody")}
                </Box>

                <Flex
                    role="radiogroup"
                    aria-label={t("review.card.subtitle")}
                    gap="4px"
                    my="2px"
                    onMouseLeave={() => setHovered(undefined)}
                >
                    {STARS.map((star) => {
                        const filled = star <= (hovered ?? rating ?? 0);
                        return (
                            <Box
                                key={star}
                                as="button"
                                type="button"
                                role="radio"
                                aria-checked={rating === star}
                                aria-label={t("review.card.starLabel", { count: star })}
                                className="review-prompt-star"
                                data-filled={filled ? "true" : "false"}
                                onMouseEnter={() => setHovered(star)}
                                onClick={() => rate(star)}
                            >
                                {filled ? "★" : "☆"}
                            </Box>
                        );
                    })}
                </Flex>

                {rating === undefined ? (
                    <Flex gap="8px" mt="2px">
                        <Button ref={dismissRef} variant="secondary" size="sm" onClick={later}>
                            {t("review.card.later")}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onAnswer({ decision: "declined" })}
                        >
                            {t("review.card.never")}
                        </Button>
                    </Flex>
                ) : (
                    <Flex direction="column" align="center" gap="8px" mt="2px">
                        <Flex gap="8px">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => onAnswer({ decision: "declined" })}
                            >
                                {t("review.card.notNow")}
                            </Button>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => onAnswer({ decision: "declined", open: "feedback" })}
                            >
                                {t("review.card.reportIssue")}
                            </Button>
                        </Flex>
                        <Box
                            as="button"
                            type="button"
                            className="review-prompt-link"
                            onClick={() => onAnswer({ decision: "declined", open: "marketplace" })}
                        >
                            {t("review.card.rateAnyway")}
                        </Box>
                    </Flex>
                )}
            </Flex>
        </Flex>
    );
}
