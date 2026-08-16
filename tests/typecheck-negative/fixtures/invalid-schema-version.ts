import type { WebviewFixture } from "../../visual/recorder/webviewFixtureTypes";

const invalidSchemaVersionFixture: WebviewFixture = {
    schemaVersion: "one",
    contextId: "commit-panel",
    scenario: "invalid-schema-version",
    messages: [],
};

export default invalidSchemaVersionFixture;
