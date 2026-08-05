import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import type { ReviewPromptDecision, ReviewPromptTarget } from "../../../protocol/commitGraphTypes";
import { t } from "../i18n";
import { Z_INDEX } from "../tokens";
import "./ReviewPromptCard.css";

/** Ratings at or above this get the marketplace ask first; below it, the feedback ask comes first. */
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
 * click only chooses which follow-up the user sees. A low rating leads with the feedback
 * route but still offers the public review link, so no one is steered away from reviewing.
 * Every star click is terminal: an answered user is never asked again, whichever route
 * they take or abandon.
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
    const happy = rating !== undefined && rating >= HAPPY_THRESHOLD;
    const decision: ReviewPromptDecision = happy ? "rated" : "declined";

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
                borderRadius="6px"
                bg="var(--intelligit-pycharm-panel)"
                color="var(--intelligit-pycharm-foreground)"
                boxShadow="0 8px 32px rgba(0, 0, 0, 0.32)"
            >
                <Box as="h2" id="review-prompt-title" fontSize="14px" fontWeight={600}>
                    {rating === undefined
                        ? t("review.card.title")
                        : happy
                          ? t("review.card.happyTitle")
                          : t("review.card.unhappyTitle")}
                </Box>
                <Box fontSize="12px" opacity={0.85}>
                    {rating === undefined
                        ? t("review.card.subtitle")
                        : happy
                          ? t("review.card.happyBody")
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
                                onClick={() => setRating(star)}
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
                                onClick={() => onAnswer({ decision })}
                            >
                                {t("review.card.notNow")}
                            </Button>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() =>
                                    onAnswer({
                                        decision,
                                        open: happy ? "marketplace" : "feedback",
                                    })
                                }
                            >
                                {happy ? t("review.card.rate") : t("review.card.reportIssue")}
                            </Button>
                        </Flex>
                        {happy ? null : (
                            <Box
                                as="button"
                                type="button"
                                className="review-prompt-link"
                                onClick={() => onAnswer({ decision, open: "marketplace" })}
                            >
                                {t("review.card.rateAnyway")}
                            </Box>
                        )}
                    </Flex>
                )}
            </Flex>
        </Flex>
    );
}
