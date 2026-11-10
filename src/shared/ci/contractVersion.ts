/**
 * Version of the persisted CI detail shape. A persisted entry with another version is
 * a cache miss. Every phase that adds or changes a persisted detail field bumps it.
 */
export const CI_DETAIL_CONTRACT_VERSION = 2;
