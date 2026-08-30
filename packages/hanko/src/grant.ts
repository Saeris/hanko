/**
 * A single authorization attempt, as an object that owns its own state.
 *
 * The state machine in `machine.ts` is pure; this class is the boundary around
 * it. `#private` fields are a genuine runtime boundary, not a compile-time
 * convention — which matters here because what is being protected is a bearer
 * credential (`device_code`) and, after approval, the identity that redeeming
 * it hands over. Nothing outside this class can reach either by accident.
 *
 * Hooks let a host app observe transitions (persist, log, push to a UI) without
 * being able to force one.
 */

import {
  grantTransition,
  isGrantSettled,
  type GrantEvent,
  type GrantState
} from "./machine.js";
import type { DeviceGrant } from "./types.js";

/** Observers of a grant's lifecycle. All optional, all fire after the move. */
export interface GrantHooks {
  /** Any successful transition. */
  onTransition?: (from: GrantState, to: GrantState, grant: DeviceGrant) => void;
  /** The user authorized. `subject` is whoever they are to the host app. */
  onApproved?: (subject: string, grant: DeviceGrant) => void;
  /** The user refused. */
  onDenied?: (grant: DeviceGrant) => void;
  /** The deadline passed without a decision, or before redemption. */
  onExpired?: (grant: DeviceGrant) => void;
  /** The device redeemed its approval. Terminal. */
  onRedeemed?: (subject: string, grant: DeviceGrant) => void;
  /**
   * An event the current state does not accept.
   *
   * Not an error — a device polling twice in a row legitimately produces one —
   * but worth surfacing, since a burst of them means a confused caller.
   */
  onRejected?: (state: GrantState, event: GrantEvent[`type`]) => void;
}

export class Grant {
  readonly #deviceCode: string;
  readonly #userCode: string;
  readonly #expiresAt: number;
  readonly #clientId: string | undefined;
  readonly #scope: string | undefined;
  readonly #hooks: GrantHooks;

  #state: GrantState;
  #subject: string | undefined;
  #interval: number;
  #lastPolledAt: number | undefined;

  constructor(grant: DeviceGrant, hooks: GrantHooks = {}) {
    this.#deviceCode = grant.device_code;
    this.#userCode = grant.user_code;
    this.#expiresAt = grant.expiresAt;
    this.#clientId = grant.clientId;
    this.#scope = grant.scope;
    this.#state = grant.status;
    this.#subject = grant.subject;
    this.#interval = grant.interval;
    this.#lastPolledAt = grant.lastPolledAt;
    this.#hooks = hooks;
  }

  /** Rehydrate from a store record. */
  static from(grant: DeviceGrant, hooks?: GrantHooks): Grant {
    return new Grant(grant, hooks);
  }

  get state(): GrantState {
    return this.#state;
  }

  get userCode(): string {
    return this.#userCode;
  }

  get interval(): number {
    return this.#interval;
  }

  get settled(): boolean {
    return isGrantSettled(this.#state);
  }

  /**
   * The approving identity — readable only once approved.
   *
   * Deliberately not a plain field: reading it in any other state is a caller
   * bug, and returning `undefined` silently would let it be handed to a session
   * factory as an empty subject.
   */
  get subject(): string {
    if (this.#state !== `approved` && this.#state !== `consumed`) {
      throw new Error(
        `subject is not available while the grant is ${this.#state}`
      );
    }
    return this.#subject ?? ``;
  }

  /** Whether this grant's deadline has passed as of `now`. */
  expired(now: number): boolean {
    return now >= this.#expiresAt;
  }

  /**
   * Whether a poll at `now` arrives sooner than the agreed interval.
   *
   * The first poll is always allowed; only a second one inside the window is
   * early. Used by the server to decide between `authorization_pending` and
   * `slow_down`.
   */
  pollingTooSoon(now: number): boolean {
    return (
      this.#lastPolledAt !== undefined &&
      now - this.#lastPolledAt < this.#interval * 1000
    );
  }

  /** Record that a poll happened, without changing state. */
  markPolled(now: number): void {
    this.#lastPolledAt = now;
  }

  /**
   * Apply `slow_down`: add 5s permanently, per RFC 8628 §3.5.
   *
   * A method rather than a setter — the increment is the spec's, not the
   * caller's, and exposing the interval for assignment would invite an
   * exponential backoff that the spec reserves for connection failures.
   */
  slowDown(now: number): number {
    this.#interval += 5;
    this.#lastPolledAt = now;
    return this.#interval;
  }

  /**
   * Send an event. Returns whether it moved the grant.
   *
   * The only way to change state. Illegal events are rejected rather than
   * throwing: double-approval and re-redemption are things a real caller does,
   * and they must be no-ops rather than crashes.
   */
  send(event: GrantEvent): boolean {
    const from = this.#state;
    const to = grantTransition(from, event);

    if (to === from) {
      this.#hooks.onRejected?.(from, event.type);
      return false;
    }

    // Set before hooks fire, so an observer that reads the grant sees the new
    // state rather than the one it just left.
    if (event.type === `APPROVE`) this.#subject = event.subject;
    this.#state = to;

    const snapshot = this.toJSON();
    this.#hooks.onTransition?.(from, to, snapshot);

    switch (event.type) {
      case `APPROVE`:
        this.#hooks.onApproved?.(event.subject, snapshot);
        break;
      case `DENY`:
        this.#hooks.onDenied?.(snapshot);
        break;
      case `EXPIRE`:
        this.#hooks.onExpired?.(snapshot);
        break;
      case `REDEEM`:
        this.#hooks.onRedeemed?.(this.#subject ?? ``, snapshot);
        break;
    }

    return true;
  }

  /**
   * Plain record for persistence.
   *
   * Named `toJSON` so `JSON.stringify` picks it up — but note it includes
   * `device_code` and `subject`, so it is a store payload, not something to
   * send to a client.
   */
  toJSON(): DeviceGrant {
    return {
      device_code: this.#deviceCode,
      user_code: this.#userCode,
      status: this.#state,
      expiresAt: this.#expiresAt,
      interval: this.#interval,
      clientId: this.#clientId,
      scope: this.#scope,
      subject: this.#subject,
      lastPolledAt: this.#lastPolledAt
    };
  }
}
