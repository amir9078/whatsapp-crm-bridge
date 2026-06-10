// Single-user auth (M7): shared password → signed expiring token (HMAC-SHA256, no deps).
// Disabled when no password is configured (local dev). Pluggable for Clerk/OIDC later —
// the rest of the app only ever calls `verify()`. Spec: docs/04 §2.1 (simplified for v1).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthConfig {
  /** The login password. Empty/undefined disables auth entirely. */
  password?: string;
  /** HMAC secret for tokens; defaults to a key derived from the password. */
  secret?: string;
  /** Token lifetime; default 7 days. */
  ttlMs?: number;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

export class Auth {
  readonly enabled: boolean;
  private readonly passwordHash: Buffer;
  private readonly secret: Buffer;
  private readonly ttlMs: number;

  constructor(cfg: AuthConfig = {}) {
    this.enabled = Boolean(cfg.password);
    this.passwordHash = sha256(cfg.password ?? '');
    this.secret = sha256(cfg.secret ?? `wcb-token:${cfg.password ?? ''}`);
    this.ttlMs = cfg.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  login(password: string): { token: string; expiresAt: string } | null {
    if (!this.enabled) return null;
    if (!timingSafeEqual(sha256(password), this.passwordHash)) return null;
    const exp = Date.now() + this.ttlMs;
    return { token: `${exp}.${this.sign(String(exp))}`, expiresAt: new Date(exp).toISOString() };
  }

  /** True when the request may proceed. Always true while auth is disabled. */
  verify(token: string | undefined): boolean {
    if (!this.enabled) return true;
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const expStr = token.slice(0, dot);
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sign(expStr));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

/** Pull the bearer token out of an Authorization header, if present. */
export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}
