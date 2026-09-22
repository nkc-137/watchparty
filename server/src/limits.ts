/**
 * Abuse controls.
 *
 * This is a friends-and-family server behind a shared secret, so the threat
 * model is modest: someone who has the invite being a nuisance, plus the
 * ordinary hygiene you want the day the URL leaks. Everything here is cheap,
 * in-memory and per-process — there is no cluster to coordinate with.
 */
import { createHash, timingSafeEqual } from "crypto";

/** Host patterns the extension actually runs on — the only legitimate origins. */
const SITE_ORIGINS =
  /^https?:\/\/([\w-]+\.)*(netflix\.com|primevideo\.com|amazon\.[\w.]+|youtube\.com|tubitv\.com|pluto\.tv)$/;

/**
 * Whether a browser Origin may open a socket.
 *
 * `allowed` overrides the built-in site list: a list of exact origins, or "*"
 * to accept anything (the old behavior, kept for anyone tunnelling from a
 * custom page). A missing origin is allowed because non-browser clients — the
 * test harness, curl, a health check — don't send one, and CORS is not what
 * gates them; JOIN_SECRET is.
 */
export function originAllowed(
  origin: string | undefined,
  allowed?: string[] | "*"
): boolean {
  if (!origin) return true;
  if (allowed === "*") return true;
  if (allowed?.length) return allowed.includes(origin);
  return SITE_ORIGINS.test(origin);
}

/** Parse the ALLOWED_ORIGINS env var: unset -> built-in list, "*" -> anything. */
export function parseAllowedOrigins(raw?: string): string[] | "*" | undefined {
  const v = (raw || "").trim();
  if (!v) return undefined;
  if (v === "*") return "*";
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so the compare is always over equal-length
 * buffers — timingSafeEqual throws on a length mismatch, and returning early
 * on length would itself leak the secret's length.
 */
export function secretMatches(expected: string, given: unknown): boolean {
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(typeof given === "string" ? given : ""));
}

export interface RateLimit {
  /** Actions allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Fixed-window counter, one per caller.
 *
 * A fixed window rather than a token bucket on purpose: the limits here are
 * about stopping a flood, not shaping a stream, and a counter that resets is
 * easier to reason about — and to explain to whoever hits it — than a refill
 * rate. Windows are created lazily and dropped with the socket.
 */
export class RateLimiter {
  private count = 0;
  private windowStart = 0;

  constructor(private readonly rule: RateLimit) {}

  /** Record an action. Returns false when it should be dropped. */
  allow(now = Date.now()): boolean {
    if (now - this.windowStart >= this.rule.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    return this.count <= this.rule.limit;
  }

  /** True the first time a window goes over, so we warn once rather than per message. */
  justExceeded(now = Date.now()): boolean {
    return this.count === this.rule.limit + 1 && now - this.windowStart < this.rule.windowMs;
  }
}
