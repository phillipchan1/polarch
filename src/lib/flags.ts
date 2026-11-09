/**
 * Named feature flags.
 *
 * Every flag defaults OFF. A merge to master deploys to production, so a
 * half-built path must not appear for anyone until the flag is turned on
 * after QA. There is no identity targeting in this module: "on for Phil
 * only" is a post-QA decision, not a hardcoded email check that would fire
 * the moment this ships.
 *
 * In local **dev** builds (`import.meta.env.DEV`), QA can turn a flag on in
 * this browser without a deploy:
 *   localStorage.setItem("polarch:v1:flags", JSON.stringify({ quickClose: true }))
 *   — or open the app with `?flag=quickClose`.
 * Reload after setting storage. Query params last for that page load only.
 * Production builds ignore both switches.
 *
 * `singleOccurrenceGuard` can also be flipped from the Worker dashboard
 * (`SINGLE_OCCURRENCE_GUARD`) or a Vite env (`VITE_SINGLE_OCCURRENCE_GUARD`)
 * — both still read as off when unset.
 */

export const FLAG_DEFAULTS = {
  quickClose: false,
  singleOccurrenceGuard: false,
} as const;

/** Same object as {@link FLAG_DEFAULTS}. */
export const FLAGS = FLAG_DEFAULTS;

export type FlagName = keyof typeof FLAG_DEFAULTS;

export const FLAG_STORAGE_KEY = "polarch:v1:flags";

const testOverrides: Partial<Record<FlagName, boolean>> = {};

/** `"1"` / `"true"` / `"on"` / `"yes"` enable; anything else (including unset) is off. */
export function flagFromEnv(raw: string | undefined | null): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Vite/wrangler compile `import.meta.env.DEV` to a boolean. Tests pass
 * `dev` explicitly so a prod-shaped call can be asserted without a Vite build.
 */
export function flagsAllowRuntimeOverride(dev: boolean | undefined = importMetaDev()): boolean {
  return dev === true;
}

function importMetaDev(): boolean | undefined {
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  return env?.DEV;
}

export type FlagRuntime = {
  /** Vite `import.meta.env.DEV`. Production compiles this to `false`. */
  dev?: boolean;
  /** `window.location.search`. */
  search?: string;
  /** `window.localStorage`. */
  storage?: Pick<Storage, "getItem"> | null;
};

/**
 * Read a flag. `overrides` is for tests: pass `{ quickClose: true }` to
 * exercise the on-path, or `{ quickClose: false }` to pin the default
 * without touching `window`.
 *
 * When `overrides` is omitted, a **dev** browser may still enable a flag via
 * localStorage or `?flag=`; production and Node never do.
 */
export function flagOn(
  name: FlagName,
  overrides?: Partial<Record<FlagName, boolean>>,
  runtime?: FlagRuntime,
): boolean {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
    return Boolean(overrides[name]);
  }
  if (Object.prototype.hasOwnProperty.call(testOverrides, name)) {
    return Boolean(testOverrides[name]);
  }
  if (flagsAllowRuntimeOverride(runtime?.dev ?? importMetaDev())) {
    const value = runtimeOverride(name, runtime);
    if (value !== undefined) return value;
  }
  return FLAG_DEFAULTS[name];
}

/** Parse `?flag=quickClose` / `?flags=quickClose,other` from a query string. */
export function flagsFromQuery(search: string): Partial<Record<FlagName, boolean>> {
  const out: Partial<Record<FlagName, boolean>> = {};
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const names = [...params.getAll("flag"), ...(params.get("flags")?.split(",") ?? [])];
  for (const raw of names) {
    const name = raw.trim();
    if (name in FLAG_DEFAULTS) out[name as FlagName] = true;
  }
  return out;
}

function runtimeOverride(name: FlagName, runtime?: FlagRuntime): boolean | undefined {
  const search =
    runtime?.search ??
    (typeof window !== "undefined" ? window.location?.search : undefined);
  if (search !== undefined) {
    try {
      const fromQuery = flagsFromQuery(search);
      if (Object.prototype.hasOwnProperty.call(fromQuery, name)) return fromQuery[name];
    } catch {
      // No Location (tests that stub window without one).
    }
  }
  try {
    const storage =
      runtime && "storage" in runtime
        ? runtime.storage
        : typeof window !== "undefined"
          ? window.localStorage
          : null;
    const raw = storage?.getItem(FLAG_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = (parsed as Record<string, unknown>)[name];
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Test-only. Pass `undefined` to restore the compiled default. */
export function setFlagForTests(name: FlagName, value: boolean | undefined): void {
  if (value === undefined) delete testOverrides[name];
  else testOverrides[name] = value;
}
