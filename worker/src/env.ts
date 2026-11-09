export interface HyperdriveBinding {
  connectionString: string;
}

export interface Env {
  ASSETS?: Fetcher;
  HYPERDRIVE?: HyperdriveBinding;
  DATABASE_URL?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  /**
   * Optional comma-separated extra origins for CORS + Better Auth.
   * `BETTER_AUTH_URL` is always trusted. Example: `https://www.polarch.day`.
   */
  TRUSTED_ORIGINS?: string;
  /**
   * Optional cookie `Domain`. Set to the registrable host when a custom
   * domain is attached (e.g. `polarch.day`). Omit on workers.dev and local.
   */
  AUTH_COOKIE_DOMAIN?: string;
  /** wrangler / `.dev.vars` only: `local` allows a localhost auth fallback. */
  ENVIRONMENT?: string;
  /** Cloudflare Email Service `send_email` binding. Primary sender. */
  EMAIL?: SendEmail;
  /** Email Service from-address. Default `Polarch <login@polarch.day>`. */
  CF_EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  /** Resend fallback from-address (verified in Resend), e.g. `Polarch <login@usedayspring.app>`. */
  AUTH_EMAIL_FROM?: string;
  /** Worker secret. Google OAuth web client (Polarch). Unset = Google off. */
  GOOGLE_CLIENT_ID?: string;
  /** Worker secret. Never a wrangler var. */
  GOOGLE_CLIENT_SECRET?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  /** Optional. Meeting audio model, from the allowlist in transcribe.ts. */
  OPENAI_TRANSCRIBE_MODEL?: string;
  /** Comma-separated allowlist. Empty = no new users. Set to Phil's email. */
  ALLOWED_EMAILS?: string;
  /**
   * Optional. `"1"` / `"true"` / `"on"` enables the same-date / off-rhythm
   * occurrence guard. Unset (the default in every environment) leaves
   * historical `addSession` behaviour in place.
   */
  SINGLE_OCCURRENCE_GUARD?: string;
}

const PLACEHOLDER_HYPERDRIVE = "00000000000000000000000000000000";

export function databaseUrl(env: Env): string | null {
  const bound = env.HYPERDRIVE?.connectionString;
  const fromHyperdrive = bound?.trim() ?? "";
  if (bound && fromHyperdrive && !fromHyperdrive.includes(PLACEHOLDER_HYPERDRIVE)) {
    return bound;
  }
  const fallback = env.DATABASE_URL?.trim() ?? "";
  return fallback || fromHyperdrive || null;
}

export function openaiModel(env: Env): string {
  return env.OPENAI_MODEL?.trim() || "gpt-5-mini";
}
