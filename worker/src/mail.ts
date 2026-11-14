import type { Env } from "./env.ts";

export function magicLinkEmail(opts: { url: string }): { subject: string; text: string; html: string } {
  const subject = "Your Polarch sign-in link";
  const text = `Sign in to Polarch:\n${opts.url}\n\nThis link expires in a few minutes. If you did not ask for it, ignore this email.`;
  const html = `<p>Sign in to Polarch:</p><p><a href="${opts.url}">Open Polarch</a></p><p>This link expires in a few minutes. If you did not ask for it, ignore this email.</p>`;
  return { subject, text, html };
}

export type MagicLinkSendFailure = {
  kind: "missing_env" | "cf_email" | "unknown";
  status?: number;
};

export class MagicLinkSendError extends Error {
  readonly kind: Exclude<MagicLinkSendFailure["kind"], "unknown">;
  readonly status?: number;
  constructor(kind: MagicLinkSendError["kind"], status?: number) {
    super("magic-link send failed");
    this.name = "MagicLinkSendError";
    this.kind = kind;
    this.status = status;
  }
}

export function describeMagicLinkSendFailure(err: unknown): MagicLinkSendFailure {
  if (err instanceof MagicLinkSendError) {
    return err.status == null ? { kind: err.kind } : { kind: err.kind, status: err.status };
  }
  return { kind: "unknown" };
}

/** Token-free, email-free. Logs kind and optional HTTP status only. */
export function logMagicLinkSendFailure(
  err: unknown,
  log: (message: string, detail: MagicLinkSendFailure) => void = console.error,
): void {
  log("magic-link send failed", describeMagicLinkSendFailure(err));
}

export type MagicLinkSoftCapSkip = { kind: "soft_cap" };

/** Token-free, email-free. Call only on the first skip in the window. */
export function logMagicLinkSoftCapSkip(
  log: (message: string, detail: MagicLinkSoftCapSkip) => void = console.error,
): void {
  log("magic-link send skipped", { kind: "soft_cap" });
}

const DEFAULT_CF_EMAIL_FROM = "Polarch <login@polarch.day>";

/** Parse `Name <addr>` or `addr` into the Email Service builder shape. */
export function parseFrom(raw: string): string | { email: string; name: string } {
  const m = raw.trim().match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  if (m) {
    const name = m[1].trim().replace(/^"|"$/g, "");
    return name ? { email: m[2], name } : m[2];
  }
  return raw.trim();
}

export function cfEmailFrom(env: Pick<Env, "CF_EMAIL_FROM">): string {
  return env.CF_EMAIL_FROM?.trim() || DEFAULT_CF_EMAIL_FROM;
}

/** Cloudflare Email Service via the `send_email` binding (from login@polarch.day). */
async function sendViaCloudflare(
  binding: SendEmail,
  env: Env,
  to: string,
  body: { subject: string; text: string; html: string },
): Promise<void> {
  try {
    await binding.send({ from: parseFrom(cfEmailFrom(env)), to, subject: body.subject, html: body.html, text: body.text });
  } catch {
    // Never surface the binding error text: it can echo the recipient.
    throw new MagicLinkSendError("cf_email");
  }
}

/**
 * Send a magic-link email via Cloudflare Email Service (`EMAIL` binding,
 * from CF_EMAIL_FROM / login@polarch.day). Fail closed if the binding is
 * missing or throws.
 */
export async function sendMagicLinkEmail(
  env: Env,
  opts: { email: string; url: string; token: string },
): Promise<"cloudflare"> {
  const to = opts.email.trim().toLowerCase();
  const body = magicLinkEmail({ url: opts.url });
  if (!env.EMAIL) {
    throw new MagicLinkSendError("missing_env");
  }
  await sendViaCloudflare(env.EMAIL, env, to, body);
  return "cloudflare";
}
