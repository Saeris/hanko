/**
 * Server side of the device-authorization flow (RFC 8628).
 *
 * Framework-agnostic and transport-agnostic: this module never touches HTTP.
 * Host apps wire these methods to whatever routes they like — Astro endpoints,
 * Next route handlers, Workers, Hono. That is what makes the same core usable
 * from Better-Auth, Supabase, or a bare in-memory dev server.
 *
 * hanko does not issue sessions or tokens. `approve()` records WHO approved (an
 * opaque `subject`), and a successful poll hands that subject back to the host
 * app, which mints whatever credential it already knows how to mint. Owning
 * session issuance would duplicate Better-Auth rather than integrate with it.
 *
 * State transitions live in `machine.ts` and are applied through `Grant`, which
 * owns them privately. Nothing here mutates a grant's status directly.
 */

import {
  generateDeviceCode,
  generateUserCode,
  normalizeUserCode
} from "./codes.js";
import type { UserCodeOptions } from "./codes.js";
import { Grant, type GrantHooks } from "./grant.js";
import type { GrantState } from "./machine.js";
import type {
  DeviceAuthorizationError,
  DeviceAuthorizationResponse,
  DeviceGrant,
  DeviceGrantStore
} from "./types.js";

export interface HankoServerOptions {
  /** Where grants live. Use `MemoryDeviceGrantStore` for dev. */
  store: DeviceGrantStore;
  /**
   * Absolute URL the user visits to approve, e.g. `https://example.com/link`.
   * Shown on the device verbatim, so keep it short and typeable.
   */
  verificationUri: string;
  /**
   * Builds the QR target. Defaults to `${verificationUri}?user_code=${code}`.
   * Override if your approval page reads the code from a path segment.
   */
  buildVerificationUriComplete?: (
    userCode: string,
    verificationUri: string
  ) => string;
  /** Code lifetime in seconds. Default 900 (15 min). */
  expiresInSeconds?: number;
  /** Starting poll interval in seconds. Spec default 5. */
  intervalSeconds?: number;
  /** Shape of the user code. See {@link UserCodeOptions}. */
  userCode?: UserCodeOptions;
  /** Injectable clock. Tests pass a fake; production leaves it alone. */
  now?: () => number;
  /**
   * Lifecycle observers, applied to every grant this server handles.
   *
   * The integration seam for host frameworks: persist to a second store, emit
   * telemetry, push to a websocket. Hooks observe; they cannot force a
   * transition.
   */
  hooks?: GrantHooks;
}

/** Discriminated result of a poll. Callers switch on `status`. */
export type PollResult =
  | {
      status: `pending`;
      error: Extract<DeviceAuthorizationError, `authorization_pending`>;
    }
  | {
      status: `slow_down`;
      error: Extract<DeviceAuthorizationError, `slow_down`>;
      interval: number;
    }
  | {
      status: `denied`;
      error: Extract<DeviceAuthorizationError, `access_denied`>;
    }
  | {
      status: `expired`;
      error: Extract<DeviceAuthorizationError, `expired_token`>;
    }
  | { status: `approved`; subject: string };

export interface ApproveResult {
  ok: boolean;
  /** Present when `ok` is false. Lets callers show a precise message. */
  reason?: `not_found` | `expired` | `already_resolved`;
  grant?: DeviceGrant;
}

export class HankoServer {
  readonly #store: DeviceGrantStore;
  readonly #verificationUri: string;
  readonly #buildVerificationUriComplete: (
    userCode: string,
    verificationUri: string
  ) => string;
  readonly #expiresInSeconds: number;
  readonly #intervalSeconds: number;
  readonly #userCodeOptions: UserCodeOptions | undefined;
  readonly #now: () => number;
  readonly #hooks: GrantHooks;

  constructor({
    store,
    verificationUri,
    buildVerificationUriComplete = (userCode, uri): string =>
      `${uri}${uri.includes(`?`) ? `&` : `?`}user_code=${encodeURIComponent(userCode)}`,
    expiresInSeconds = 900,
    intervalSeconds = 5,
    userCode,
    now = (): number => Date.now(),
    hooks = {}
  }: HankoServerOptions) {
    this.#store = store;
    this.#verificationUri = verificationUri;
    this.#buildVerificationUriComplete = buildVerificationUriComplete;
    this.#expiresInSeconds = expiresInSeconds;
    this.#intervalSeconds = intervalSeconds;
    this.#userCodeOptions = userCode;
    this.#now = now;
    this.#hooks = hooks;
  }

  /**
   * Load a grant and settle its deadline before anyone reads its state.
   *
   * Expiry is evaluated lazily on read rather than by a timer. A background
   * sweep cannot be relied on: serverless instances die, and a TV left on for
   * days outlives any interval we set. Checking at the point of use means a
   * grant is never observed as live past its deadline, whatever the host's
   * lifecycle looks like.
   */
  async #load(record: DeviceGrant | null): Promise<Grant | null> {
    if (!record) return null;

    const grant = Grant.from(record, this.#hooks);
    // Sent unconditionally: the machine decides whether EXPIRE is legal in the
    // current state, so this correctly expires a stale `approved` grant that
    // was never redeemed, not just a `pending` one.
    if (grant.expired(this.#now()) && grant.send({ type: `EXPIRE` })) {
      await this.#store.update(grant.toJSON());
    }
    return grant;
  }

  /**
   * Start a flow. Call from the device-authorization endpoint.
   *
   * Returns the spec's response shape directly, so a host route can serialize
   * it as-is.
   */
  async requestAuthorization({
    clientId,
    scope
  }: {
    clientId?: string;
    scope?: string;
  } = {}): Promise<DeviceAuthorizationResponse> {
    const displayCode = generateUserCode(this.#userCodeOptions);
    const record: DeviceGrant = {
      device_code: generateDeviceCode(),
      // Stored normalized so lookup never depends on the display format.
      user_code: normalizeUserCode(displayCode),
      status: `pending`,
      expiresAt: this.#now() + this.#expiresInSeconds * 1000,
      interval: this.#intervalSeconds,
      clientId,
      scope
    };
    await this.#store.create(record);
    await this.#store.prune?.(this.#now());

    return {
      device_code: record.device_code,
      // The DISPLAY form goes on the wire — the device shows it verbatim.
      user_code: displayCode,
      verification_uri: this.#verificationUri,
      verification_uri_complete: this.#buildVerificationUriComplete(
        displayCode,
        this.#verificationUri
      ),
      expires_in: this.#expiresInSeconds,
      interval: this.#intervalSeconds
    };
  }

  /**
   * Poll for a decision. Call from the token endpoint.
   *
   * Enforces the interval: polling faster than allowed returns `slow_down` and
   * permanently raises this grant's interval by 5s, per §3.5. The increase is
   * additive and sticky — NOT exponential backoff, which the spec reserves for
   * connection timeouts.
   */
  async poll(deviceCode: string): Promise<PollResult> {
    const grant = await this.#load(
      await this.#store.findByDeviceCode(deviceCode)
    );
    // An unknown device_code is reported as expired rather than "not found":
    // distinguishing them would confirm which codes exist to an attacker.
    if (!grant) return { status: `expired`, error: `expired_token` };

    switch (grant.state) {
      case `denied`:
        return { status: `denied`, error: `access_denied` };
      // A consumed grant reports as expired: a device_code is a bearer
      // credential, so a replayed poll must not hand out the subject twice.
      case `consumed`:
      case `expired`:
        return { status: `expired`, error: `expired_token` };
      case `approved`: {
        // Read the subject BEFORE redeeming — `consumed` still permits it, but
        // ordering it this way keeps the read adjacent to the state that earned
        // it rather than depending on `consumed` staying readable.
        const { subject } = grant;
        grant.send({ type: `REDEEM` });
        await this.#store.update(grant.toJSON());
        return { status: `approved`, subject };
      }
      case `pending`: {
        const at = this.#now();
        if (grant.pollingTooSoon(at)) {
          const interval = grant.slowDown(at);
          await this.#store.update(grant.toJSON());
          return { status: `slow_down`, error: `slow_down`, interval };
        }
        grant.markPolled(at);
        await this.#store.update(grant.toJSON());
        return { status: `pending`, error: `authorization_pending` };
      }
    }
  }

  /**
   * Look up a grant by the code the user typed or arrived with.
   *
   * The approval page MUST display the returned `user_code` back to the user so
   * they can confirm it matches the screen — RFC 8628 §5.4. That check is the
   * only defense against a phished QR pointing at an attacker's device, so it
   * is not optional UI polish.
   */
  async lookupByUserCode(input: string): Promise<DeviceGrant | null> {
    const grant = await this.#load(
      await this.#store.findByUserCode(normalizeUserCode(input))
    );
    return grant?.toJSON() ?? null;
  }

  /** Record approval. `subject` is opaque to hanko; it is echoed back on poll. */
  async approve(input: string, subject: string): Promise<ApproveResult> {
    return this.#decide(input, { type: `APPROVE`, subject });
  }

  /** Record denial, so the device can stop polling and say why. */
  async deny(input: string): Promise<ApproveResult> {
    return this.#decide(input, { type: `DENY` });
  }

  /**
   * Shared path for approve/deny.
   *
   * Both are the same operation modulo the event, and the machine — not a
   * ladder of guard clauses here — decides whether the move is legal. That is
   * what makes approving a denied grant, or re-deciding a consumed one,
   * impossible rather than merely checked for.
   */
  async #decide(
    input: string,
    event: { type: `APPROVE`; subject: string } | { type: `DENY` }
  ): Promise<ApproveResult> {
    const grant = await this.#load(
      await this.#store.findByUserCode(normalizeUserCode(input))
    );
    if (!grant) return { ok: false, reason: `not_found` };

    if (!grant.send(event)) {
      return {
        ok: false,
        reason: reasonFor(grant.state),
        grant: grant.toJSON()
      };
    }

    const snapshot = grant.toJSON();
    await this.#store.update(snapshot);
    return { ok: true, grant: snapshot };
  }
}

/** Why a decision was refused, from the state that refused it. */
const reasonFor = (state: GrantState): `expired` | `already_resolved` =>
  state === `expired` ? `expired` : `already_resolved`;

/**
 * Factory kept for ergonomics and backwards compatibility.
 *
 * The class is the real API; this is sugar for callers who prefer not to write
 * `new`, and it keeps existing call sites working.
 */
export const createHankoServer = (options: HankoServerOptions): HankoServer =>
  new HankoServer(options);
