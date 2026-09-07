import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "podcast_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Owner-only access for a single private deployment.
 *
 * Deliberately minimal and replaceable: one shared token proves ownership, and
 * a signed cookie carries the session afterwards. There are no accounts, no
 * password storage and no recovery flow, because there is exactly one user.
 */
export class OwnerAuth {
  private readonly secret: Buffer;

  constructor(
    private readonly token: string,
    secret: string,
  ) {
    this.secret = Buffer.from(secret, "utf8");
  }

  /** Constant-time so a wrong token cannot be discovered a character at a time. */
  verifyToken(candidate: string): boolean {
    return constantTimeEquals(Buffer.from(candidate, "utf8"), Buffer.from(this.token, "utf8"));
  }

  /** A session value: random id and expiry, signed so it cannot be forged or extended. */
  issueSession(now = Date.now()): string {
    const payload = `${randomBytes(16).toString("hex")}.${now + SESSION_TTL_MS}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verifySession(value: string | undefined, now = Date.now()): boolean {
    if (!value) return false;
    const parts = value.split(".");
    if (parts.length !== 3) return false;

    const [id, expiry, signature] = parts as [string, string, string];
    const payload = `${id}.${expiry}`;
    if (!constantTimeEquals(Buffer.from(signature, "utf8"), Buffer.from(this.sign(payload), "utf8"))) {
      return false;
    }

    const expiresAt = Number(expiry);
    return Number.isFinite(expiresAt) && expiresAt > now;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
}

function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual requires equal lengths, and length alone leaks little here.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Cookie attributes.
 *
 * `Secure` is set when the deployment is served over HTTPS. It is omitted for
 * local HTTP validation, since a Secure cookie would never be sent back and
 * login would silently fail.
 */
export function sessionCookie(value: string, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearedCookie(secure: boolean): string {
  const attributes = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
