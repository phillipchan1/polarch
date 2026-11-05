/** Lifetimes, prefixes and limits shared by the OAuth routes and the bearer check. */

export const ACCESS_PREFIX = "pla_";
export const REFRESH_PREFIX = "plr_";
export const CODE_PREFIX = "plk_";
export const CLIENT_PREFIX = "cl_";
/** A personal access token's client id. The Settings list tells tokens from apps by it. */
export const PERSONAL_CLIENT_PREFIX = "pat_";

export const ACCESS_TTL_SEC = 60 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
export const CODE_TTL_SEC = 5 * 60;
/** A refresh chain that is used steadily still ends here: re-approve twice a year. */
/** A personal access token lives a year; make a new one (and delete the old) to rotate. */
export const PERSONAL_TOKEN_TTL_SEC = 365 * 24 * 60 * 60;
/** Live personal tokens per user: enough for every bot, few enough to notice a leak. */
export const PERSONAL_TOKEN_CAP = 10;
export const MAX_GRANT_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** `last_used_at` is a convenience for the Settings list, not worth a write per call. */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Registered clients, ever, that nobody has approved are pruned; this bounds the rest. */
export const CLIENT_CAP = 500;

export const OAUTH_RATE = {
  register: { window: 60 * 60, max: 20 },
  authorize: { window: 60, max: 60 },
  token: { window: 60, max: 60 },
  tokenClient: { window: 60, max: 60 },
  revoke: { window: 60, max: 60 },
} as const;
