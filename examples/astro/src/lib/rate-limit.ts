/**
 * Attempt limiting for the approval endpoint.
 *
 * RFC 8628 §5.1 REQUIRES this, and a short code makes it load-bearing rather
 * than defensive. The demo's 4-character code carries roughly 17 bits — about
 * 160,000 combinations — which is trivially brute-forceable at HTTP speed and
 * perfectly safe at five attempts per window. Plex ships a code this short for
 * the same reason: the entropy budget moved from the code to the limiter.
 *
 * Counted per (IP, code) pair rather than per IP alone: a taproom where every
 * device shares one NAT address would otherwise lock out real users the moment
 * one of them fat-fingered a code.
 *
 * In-memory, so it is per-instance and resets on restart. Correct for a demo
 * on one Node process and WRONG for the edge deployment hanko targets, where
 * an attacker just spreads attempts across instances — use Upstash, Durable
 * Objects, or your platform's limiter there.
 */

interface Attempt {
  count: number;
  /** Epoch ms when this window opened. */
  since: number;
}

export interface RateLimitOptions {
  /** Attempts allowed per window. RFC 8628 §5.1 suggests five. */
  max?: number;
  /** Window length in ms. */
  windowMs?: number;
  now?: () => number;
}

/**
 * Best-effort client address.
 *
 * Behind a proxy the socket address is the proxy's, so the forwarded chain is
 * the only source of the real one. Falls back to a constant, which makes the
 * limiter global rather than per-client — degraded but never absent, since a
 * limiter that silently stops limiting is worse than a strict one.
 */
const clientKey = (request: Request): string => {
  const forwarded = request.headers
    .get(`x-forwarded-for`)
    ?.split(`,`)[0]
    ?.trim();
  if (forwarded !== undefined && forwarded.length > 0) return forwarded;
  return request.headers.get(`cf-connecting-ip`) ?? `unknown`;
};

export const createRateLimiter = ({
  max = 5,
  windowMs = 60_000,
  now = (): number => Date.now()
}: RateLimitOptions = {}): ((
  request: Request,
  userCode: string
) => boolean) => {
  const attempts = new Map<string, Attempt>();

  return (request, userCode) => {
    const at = now();
    const key = `${clientKey(request)}:${userCode.toUpperCase()}`;

    // Swept opportunistically rather than on a timer: a serverless instance
    // may be frozen between requests, so a timer cannot be relied on to run.
    for (const [existing, attempt] of attempts) {
      if (at - attempt.since > windowMs) attempts.delete(existing);
    }

    const current = attempts.get(key);
    if (current === undefined || at - current.since > windowMs) {
      attempts.set(key, { count: 1, since: at });
      return true;
    }

    current.count += 1;
    // Deliberately does NOT extend the window on a rejected attempt. Sliding it
    // forward would let an attacker keep a victim locked out indefinitely by
    // continuing to guess.
    return current.count <= max;
  };
};
