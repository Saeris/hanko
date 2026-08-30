/**
 * Device-side polling loop (RFC 8628).
 *
 * Runs on the constrained device (TV, kiosk, Pi). Deliberately dependency-free
 * and DOM-free so it works in a Fire OS WebView, a browser, or Node.
 *
 * Transport is polling only, per the spec. No SSE, no WebSocket: this screen
 * may stay powered on for days, and a persistent connection is one more thing
 * to leak, reconnect, and debug on hardware we cannot attach a profiler to.
 *
 * The loop is a state machine (`machine.ts`) wrapped in a class that owns the
 * state and the in-flight `device_code`. Hooks let a UI render every transition
 * without reaching into that state.
 */

import {
  eventForTokenError,
  isPollSettled,
  pollContextTransition,
  pollTransition,
  type PollContext,
  type PollEvent,
  type PollState
} from "../machine.js";
import { DEVICE_CODE_GRANT_TYPE } from "../types.js";
import type {
  DeviceAuthorizationError,
  DeviceAuthorizationResponse
} from "../types.js";

/** What the host's token endpoint returns. Mirrors RFC 8628 §3.5. */
export interface TokenEndpointResponse {
  error?: DeviceAuthorizationError;
  [key: string]: unknown;
}

/** Observers of the poll loop. All optional, all fire after the move. */
export interface PollHooks {
  /** Any successful transition, with the context that produced it. */
  onTransition?: (from: PollState, to: PollState, context: PollContext) => void;
  /** A poll returned `authorization_pending`. Good place for a "still waiting" cue. */
  onPending?: (context: PollContext) => void;
  /**
   * The server asked us to slow down. Receives the NEW interval, so a UI can
   * show the changed cadence rather than a stale one.
   */
  onSlowDown?: (intervalSeconds: number, context: PollContext) => void;
  /** A request failed at the network level. The flow continues. */
  onNetworkError?: (error: unknown, context: PollContext) => void;
}

/**
 * Cancellable delay. Exported so callers (and tests) reuse the same abort-aware
 * behavior the loop relies on rather than reimplementing it.
 */
export const sleep = async (
  ms: number,
  signal?: AbortSignal
): Promise<void> => {
  if (signal?.aborted) return;
  // The timer and the abort listener race. Whichever fires first cancels the
  // other. Without the abort path the loop finishes a full interval before
  // noticing it was cancelled — a visibly stuck UI on a long cadence.
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener(`abort`, finish);
      // oxlint-disable-next-line promise/no-multiple-resolved
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener(`abort`, finish, { once: true });
  });
};

export interface DeviceAuthClientOptions {
  /** Token endpoint URL. */
  tokenUrl: string;
  /** From the authorization response. */
  deviceCode: string;
  /** Seconds between polls, from the authorization response. */
  interval: number;
  /** Seconds until both codes die, from the authorization response. */
  expiresIn: number;
  /** Sent as `client_id` when the host app tracks clients. */
  clientId?: string;
  /** Lifecycle observers. */
  hooks?: PollHooks;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, for tests. */
  now?: () => number;
  /**
   * Injectable delay, for tests.
   *
   * Exposed so the growing intervals (`slow_down`, network backoff) can be
   * asserted without a suite that actually waits minutes for them.
   */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Terminal outcomes of the loop. */
export type AuthorizationOutcome =
  | { status: `authorized`; tokens: TokenEndpointResponse }
  | { status: `denied` }
  | { status: `expired` }
  | { status: `aborted` };

export class DeviceAuthClient {
  readonly #tokenUrl: string;
  readonly #deviceCode: string;
  readonly #clientId: string | undefined;
  readonly #hooks: PollHooks;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  #state: PollState = `idle`;
  #context: PollContext;
  #tokens: TokenEndpointResponse | undefined;

  constructor({
    tokenUrl,
    deviceCode,
    interval,
    expiresIn,
    clientId,
    hooks = {},
    fetchImpl = fetch,
    now = (): number => Date.now(),
    sleepImpl = sleep
  }: DeviceAuthClientOptions) {
    this.#tokenUrl = tokenUrl;
    this.#deviceCode = deviceCode;
    this.#clientId = clientId;
    this.#hooks = hooks;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#sleep = sleepImpl;
    this.#context = {
      intervalSeconds: interval,
      deadline: now() + expiresIn * 1000,
      attempts: 0
    };
  }

  get state(): PollState {
    return this.#state;
  }

  /** Snapshot of the extended state — interval, deadline, attempts. */
  get context(): Readonly<PollContext> {
    return { ...this.#context };
  }

  get settled(): boolean {
    return isPollSettled(this.#state);
  }

  /** Apply an event to both reducers, then fire hooks. */
  #send(event: PollEvent): void {
    const from = this.#state;
    const to = pollTransition(from, event);
    this.#context = pollContextTransition(this.#context, event);

    if (to === from) return;
    this.#state = to;
    this.#hooks.onTransition?.(from, to, this.context);
  }

  /**
   * Run until the flow resolves.
   *
   * Resolves rather than throws on every RFC-defined terminal state — denial
   * and expiry are normal outcomes the UI must render, not exceptions.
   */
  async run(signal?: AbortSignal): Promise<AuthorizationOutcome> {
    this.#send({ type: `START` });

    while (!this.settled) {
      if (signal?.aborted) {
        this.#send({ type: `ABORT` });
        break;
      }

      // Stop on our own deadline even if the server never says `expired_token`
      // — a device that polls a dead code forever is a support call.
      if (this.#now() >= this.#context.deadline) {
        this.#send({ type: `DEADLINE` });
        break;
      }

      await this.#sleep(this.#context.intervalSeconds * 1000, signal);
      if (signal?.aborted) {
        this.#send({ type: `ABORT` });
        break;
      }

      this.#send({ type: `TICK` });
      await this.#poll(signal);
    }

    return this.#outcome();
  }

  /** One request, mapped to an event. */
  async #poll(signal?: AbortSignal): Promise<void> {
    let body: unknown;
    try {
      const res = await this.#fetch(this.#tokenUrl, {
        method: `POST`,
        headers: { "content-type": `application/x-www-form-urlencoded` },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: this.#deviceCode,
          ...(this.#clientId === undefined ? {} : { client_id: this.#clientId })
        }),
        signal
      });
      body = await res.json();
    } catch (error) {
      if (signal?.aborted) {
        this.#send({ type: `ABORT` });
        return;
      }
      // Venue wifi drops. A blip must not look like denial — the user has done
      // nothing wrong and the code is still valid. The context reducer applies
      // exponential backoff here, unlike `slow_down`'s fixed +5s.
      this.#send({ type: `NETWORK_ERROR` });
      this.#hooks.onNetworkError?.(error, this.context);
      return;
    }

    // A non-object body cannot be a token response. Retrying is the safe
    // reading: treating it as success would sign the device in on garbage, and
    // treating it as denial would blame the user for a broken endpoint.
    if (typeof body !== `object` || body === null) {
      this.#send({ type: `AUTHORIZATION_PENDING` });
      this.#hooks.onPending?.(this.context);
      return;
    }

    const response: TokenEndpointResponse = { ...body };
    // Only `error` is interpreted, and `errorCode` distinguishes "absent"
    // (success) from "present but not a string" (malformed). Collapsing the
    // second into the first would read a broken response as success and sign
    // the device in on garbage.
    const event = eventForTokenError(errorCode(body));

    // Captured before the transition so the terminal outcome can return it;
    // the body is the host app's credential payload, passed through
    // uninterpreted.
    if (event.type === `SUCCESS`) this.#tokens = response;

    this.#send(event);

    if (event.type === `AUTHORIZATION_PENDING`) {
      this.#hooks.onPending?.(this.context);
    } else if (event.type === `SLOW_DOWN`) {
      this.#hooks.onSlowDown?.(this.#context.intervalSeconds, this.context);
    }
  }

  #outcome(): AuthorizationOutcome {
    switch (this.#state) {
      case `authorized`:
        return { status: `authorized`, tokens: this.#tokens ?? {} };
      case `denied`:
        return { status: `denied` };
      case `expired`:
        return { status: `expired` };
      case `aborted`:
        return { status: `aborted` };
      // `run` only calls this once the machine has settled, so the live states
      // are unreachable. Reported as aborted rather than thrown: a UI showing
      // "cancelled" is a better failure than a crashed sign-in screen.
      case `idle`:
      case `waiting`:
      case `polling`:
        return { status: `aborted` };
    }
  }
}

/**
 * Poll until the flow resolves.
 *
 * Function form of {@link DeviceAuthClient} for callers who do not need to
 * observe state — the common case on a TV screen that only cares about the
 * final outcome.
 */
export const pollUntilAuthorized = async ({
  signal,
  onPending,
  onSlowDown,
  ...options
}: DeviceAuthClientOptions & {
  signal?: AbortSignal;
  /** Convenience passthroughs, so existing callers keep working. */
  onPending?: () => void;
  onSlowDown?: (nextIntervalSeconds: number) => void;
}): Promise<AuthorizationOutcome> =>
  new DeviceAuthClient({
    ...options,
    hooks: {
      ...options.hooks,
      onPending: (context) => {
        onPending?.();
        options.hooks?.onPending?.(context);
      },
      onSlowDown: (interval, context) => {
        onSlowDown?.(interval);
        options.hooks?.onSlowDown?.(interval, context);
      }
    }
  }).run(signal);

/**
 * Read the `error` field of a token response.
 *
 * Returns `undefined` only when the field is genuinely absent — that is the
 * success signal. A present-but-non-string value is reported as a placeholder
 * so it maps to the unknown-code branch and keeps polling, rather than being
 * mistaken for success.
 */
const errorCode = (body: object): string | undefined => {
  if (!(`error` in body)) return undefined;
  return typeof body.error === `string` ? body.error : `malformed_error`;
};

/**
 * Narrow an arbitrary JSON body to a device-authorization response.
 *
 * A predicate rather than a cast: the two fields the device screen cannot
 * render without are actually checked, so the narrowing is proven rather than
 * asserted. The optional fields are left unverified — a missing `interval` has
 * a spec default, and a missing `verification_uri_complete` only costs the QR.
 */
const isDeviceAuthorizationResponse = (
  body: unknown
): body is DeviceAuthorizationResponse =>
  typeof body === `object` &&
  body !== null &&
  `device_code` in body &&
  typeof body.device_code === `string` &&
  `user_code` in body &&
  typeof body.user_code === `string`;

/** Convenience: start a flow against the host's device-authorization endpoint. */
export const requestDeviceAuthorization = async ({
  authorizationUrl,
  clientId,
  scope,
  fetchImpl = fetch
}: {
  authorizationUrl: string;
  clientId?: string;
  scope?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceAuthorizationResponse> => {
  const res = await fetchImpl(authorizationUrl, {
    method: `POST`,
    headers: { "content-type": `application/x-www-form-urlencoded` },
    body: new URLSearchParams({
      ...(clientId === undefined ? {} : { client_id: clientId }),
      ...(scope === undefined ? {} : { scope })
    })
  });
  if (!res.ok) throw new Error(`device authorization failed: ${res.status}`);

  const body: unknown = await res.json();
  // Fail loud at the boundary (CLAUDE.md Rule 11). Without the required fields
  // the device screen would render a blank code and an unscannable QR, with no
  // hint as to why — far worse than an error naming the bad response.
  if (!isDeviceAuthorizationResponse(body)) {
    throw new Error(`device authorization returned an unexpected body`);
  }
  return body;
};
