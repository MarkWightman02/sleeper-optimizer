/**
 * Every Optimize run re-fetches volatile sources (projections, injuries, schedules, news, depth charts, usage stats and
 * Sleeper's player catalog, which carries injury status). A max age of 0 means no cached copy is ever "fresh enough".
 * Cached copies are used only as a clearly-flagged fallback when a live refresh fails. Only static reference data
 * (the player ID crosswalk) keeps a multi-hour TTL.
 */
export const VOLATILE_MAX_AGE_MS = 0;
export const STATIC_REFERENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const STALE_FALLBACK_DETAIL = 'STALE: live refresh failed, so an older cached copy was used.';
