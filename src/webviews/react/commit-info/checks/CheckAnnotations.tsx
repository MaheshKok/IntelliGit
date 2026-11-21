import type React from "react";
import type { CommitCiDetail } from "../../../../types";
import type { OpenCiAnnotationMessage } from "../../../protocol/commitCiMessages";
import { t } from "../../shared/i18n";
import { getVsCodeApi } from "../../shared/vscodeApi";
import { checksStyles } from "./checksStyles";

let lastRequestId = 0;

/**
 * "Annotations": HEAD's CI failure notes the host placed in the Problems panel, each opening
 * its file at its line, with the count it could not place and the page-bound note; or why
 * they could not be read. Nothing when the detail carries no annotations.
 */
export function CheckAnnotations({
    repoKey,
    hash,
    detail,
}: {
    repoKey: string;
    hash: string;
    detail: CommitCiDetail | undefined;
}): React.ReactElement | null {
    const view = detail?.annotations;
    if (!view) return null;
    const title = t("commit.checks.tab.annotations");
    const open = (path: string, line: number): void => {
        getVsCodeApi<OpenCiAnnotationMessage>().postMessage({
            type: "openCiAnnotation",
            requestId: ++lastRequestId,
            repoKey,
            hash,
            path,
            line,
        });
    };
    let unavailable: string | undefined;
    if (view.unavailable && "forbidden" in view.unavailable) {
        unavailable = t("commit.checks.tab.annotationsForbidden");
    } else if (view.unavailable) {
        unavailable = t("commit.checks.tab.annotationsUnavailable", {
            reason: view.unavailable.reason,
        });
    }
    return (
        <section data-testid="ci-annotations" aria-label={title} style={sectionStyle}>
            <div style={{ fontWeight: 600 }}>{title}</div>
            {unavailable !== undefined ? (
                <div role="alert" style={checksStyles.note}>
                    {unavailable}
                </div>
            ) : null}
            {view.items.length > 0 ? (
                <ul style={listStyle}>
                    {view.items.map((item, index) => (
                        // The same file and line can carry several notes.
                        // react-doctor-disable-next-line react-doctor/no-array-index-as-key
                        <li key={`${item.path}:${item.line}:${index}`} style={rowStyle}>
                            <button
                                type="button"
                                data-testid="ci-annotation"
                                style={checksStyles.linkButton}
                                onClick={() => open(item.path, item.line)}
                            >
                                {`${item.path}:${item.line}`}
                            </button>
                            <span style={messageStyle}>{item.message}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
            {view.rejected > 0 ? (
                <div data-testid="ci-annotations-rejected" style={checksStyles.note}>
                    {t("commit.checks.tab.annotationsRejected", { count: view.rejected })}
                </div>
            ) : null}
            {view.truncated ? (
                <div data-testid="ci-annotations-truncated" style={checksStyles.note}>
                    {t("commit.checks.tab.annotationsTruncated")}
                </div>
            ) : null}
        </section>
    );
}

const sectionStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 6,
    padding: "8px 12px",
    minWidth: 0,
};

const listStyle: React.CSSProperties = {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 0,
};

const rowStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "baseline",
    minWidth: 0,
};

const messageStyle: React.CSSProperties = {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
};
