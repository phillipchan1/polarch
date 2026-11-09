/**
 * Named feature flags.
 *
 * Every flag defaults OFF. A merge to master deploys to production, so a
 * half-built path must not appear for anyone until the flag is turned on
 * after QA. There is no identity targeting in this module: "on for Phil
 * only" is a post-QA decision, not a hardcoded email check that would fire
 * the moment this ships.
 *
 * QA can turn a flag on in this browser without a deploy:
 *   localStorage.setItem("polarch:v1:flags", JSON.stringify({ quickClose: true }))
 *   — or open the app with `?flag=quickClose`.
 * Reload after setting storage. Query params last for that page load only.
 */

export const FLAG_DEFAULTS = {
  quickClose: false,
} as const;

export type FlagName = keyof typeof FLAG_DEFAULTS;

const STORAGE_KEY = "polarch:v1:flags";

/**
 * Read a flag. `overrides` is for tests: pass `{ quickClose: true }` to
 * exercise the on-path, or `{ quickClose: false }` to pin the default
 * without touching `window`.
 *
 * When `overrides` is omitted, a browser may still enable a flag via
 * localStorage or `?flag=`; Node (the check files) never does.
 */
export function flagOn(
  name: FlagName,
  overrides?: Partial<Record<FlagName, boolean>>,
): boolean {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
    return Boolean(overrides[name]);
  }
  const runtime = runtimeOverride(name);
  if (runtime !== undefined) return runtime;
  return FLAG_DEFAULTS[name];
}

/** Parse `?flag=quickClose` / `?flags=quickClose,other` from a query string. */
export function flagsFromQuery(search: string): Partial<Record<FlagName, boolean>> {
  const out: Partial<Record<FlagName, boolean>> = {};
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const names = [...params.getAll("flag"), ...(params.get("flags")?.split(",") ?? [])];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "quickClose") out.quickClose = true;
  }
  return out;
}

function runtimeOverride(name: FlagName): boolean | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const fromQuery = flagsFromQuery(window.location.search);
    if (Object.prototype.hasOwnProperty.call(fromQuery, name)) return fromQuery[name];
  } catch {
    // No Location (tests that stub window without one).
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = (parsed as Record<string, unknown>)[name];
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}
