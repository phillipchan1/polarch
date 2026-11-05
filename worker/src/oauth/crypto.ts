/** Token generation, hashing and PKCE. Web Crypto only (Workers and Node 22). */

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `prefix` + 256 bits of CSPRNG output, so a leaked secret is recognizable to scanners. */
export function randomSecret(prefix: string, bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return `${prefix}${base64url(buf)}`;
}

/** Non-secret identifiers (client ids, grant ids, token row ids). */
export function randomId(prefix: string, bytes = 16): string {
  return randomSecret(prefix, bytes);
}

const enc = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return base64url(new Uint8Array(digest));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-leaking, content-constant-time compare. Both inputs are fixed-length secrets here. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** RFC 7636 §4.1: 43–128 unreserved characters. */
export const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is the 43-char base64url of a SHA-256 digest. */
export const CODE_CHALLENGE_S256 = /^[A-Za-z0-9_-]{43}$/;

export async function pkceS256Matches(verifier: string, challenge: string): Promise<boolean> {
  if (!CODE_VERIFIER.test(verifier)) return false;
  return timingSafeEqual(await sha256Base64url(verifier), challenge);
}
