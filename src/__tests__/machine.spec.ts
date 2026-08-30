import { describe, expect, it, vi } from "vitest";
import {
  canTransitionGrant,
  canTransitionPoll,
  eventForTokenError,
  grantTransition,
  isGrantSettled,
  isPollSettled,
  pollContextTransition,
  pollTransition,
  type GrantState,
  type PollContext,
  type PollState
} from "../machine.js";
import { Grant, type GrantHooks } from "../grant.js";
import type { DeviceGrant } from "../types.js";

const TERMINAL_GRANT_STATES: GrantState[] = [`denied`, `expired`, `consumed`];

describe(`grant machine`, () => {
  it(`moves a pending grant to each decision`, () => {
    expect(grantTransition(`pending`, { type: `APPROVE`, subject: `x` })).toBe(
      `approved`
    );
    expect(grantTransition(`pending`, { type: `DENY` })).toBe(`denied`);
    expect(grantTransition(`pending`, { type: `EXPIRE` })).toBe(`expired`);
  });

  it(`ends the flow at redemption, not approval`, () => {
    // WHY: a device_code is a bearer credential. If approval were terminal the
    // grant would stay redeemable, so anyone replaying a captured code could
    // mint sessions indefinitely.
    expect(grantTransition(`approved`, { type: `REDEEM` })).toBe(`consumed`);
    expect(isGrantSettled(`approved`)).toBe(false);
    expect(isGrantSettled(`consumed`)).toBe(true);
  });

  it(`expires an approval nobody collected`, () => {
    // WHY: the short lifetime is what limits a phished code's value. An
    // approval left uncollected past the deadline must not stay redeemable —
    // this transition is easy to omit when expiry is written as an
    // `if (status === "pending")` guard instead of a table.
    expect(grantTransition(`approved`, { type: `EXPIRE` })).toBe(`expired`);
  });

  it(`refuses every event once settled`, () => {
    // WHY: this is what makes overriding a user's denial impossible rather than
    // merely guarded against. A second APPROVE on a denied grant must be inert.
    for (const state of TERMINAL_GRANT_STATES) {
      expect(grantTransition(state, { type: `APPROVE`, subject: `x` })).toBe(
        state
      );
      expect(grantTransition(state, { type: `DENY` })).toBe(state);
      expect(grantTransition(state, { type: `REDEEM` })).toBe(state);
      expect(grantTransition(state, { type: `EXPIRE` })).toBe(state);
      expect(isGrantSettled(state)).toBe(true);
    }
  });

  it(`reports legality without applying the event`, () => {
    expect(canTransitionGrant(`pending`, `APPROVE`)).toBe(true);
    expect(canTransitionGrant(`consumed`, `REDEEM`)).toBe(false);
  });
});

describe(`grant`, () => {
  const record = (overrides: Partial<DeviceGrant> = {}): DeviceGrant => ({
    device_code: `dev`,
    user_code: `WDJBMJHT`,
    status: `pending`,
    expiresAt: 1_000_000,
    interval: 5,
    ...overrides
  });

  it(`hides the subject until the grant is approved`, () => {
    // WHY: the whole reason this is a class. Returning `undefined` silently
    // would let an empty subject reach a session factory and mint a session
    // belonging to nobody; throwing names the caller bug at its source.
    const grant = new Grant(record());
    expect(() => grant.subject).toThrow(/not available/u);

    grant.send({ type: `APPROVE`, subject: `did:plc:example` });
    expect(grant.subject).toBe(`did:plc:example`);
  });

  it(`reports whether an event moved it`, () => {
    // WHY: callers branch on this instead of re-deriving legality, so a wrong
    // return value would let the server persist a no-op as a decision.
    const grant = new Grant(record());
    expect(grant.send({ type: `APPROVE`, subject: `a` })).toBe(true);
    expect(grant.send({ type: `APPROVE`, subject: `b` })).toBe(false);
    // The rejected event must not have overwritten the first approval.
    expect(grant.subject).toBe(`a`);
  });

  it(`fires lifecycle hooks with the state already applied`, () => {
    // WHY: hooks are the framework integration seam. An observer that persists
    // the grant must see the state it moved TO, not the one it left, or the
    // store ends up one transition behind.
    const onTransition = vi.fn<NonNullable<GrantHooks[`onTransition`]>>();
    const onApproved = vi.fn<NonNullable<GrantHooks[`onApproved`]>>();
    const grant = new Grant(record(), { onTransition, onApproved });

    grant.send({ type: `APPROVE`, subject: `did:plc:example` });

    expect(onTransition).toHaveBeenCalledWith(
      `pending`,
      `approved`,
      expect.objectContaining({
        status: `approved`,
        subject: `did:plc:example`
      })
    );
    expect(onApproved).toHaveBeenCalledWith(
      `did:plc:example`,
      expect.objectContaining({ status: `approved` })
    );
  });

  it(`surfaces rejected events without throwing`, () => {
    // WHY: a device polling twice legitimately produces one of these, so it
    // cannot be an error — but a burst of them means a confused caller worth
    // seeing in logs.
    const onRejected = vi.fn<NonNullable<GrantHooks[`onRejected`]>>();
    const grant = new Grant(record({ status: `denied` }), { onRejected });

    expect(grant.send({ type: `APPROVE`, subject: `x` })).toBe(false);
    expect(onRejected).toHaveBeenCalledWith(`denied`, `APPROVE`);
  });

  it(`adds exactly five seconds per slow_down`, () => {
    // WHY: RFC 8628 §3.5 is additive and sticky, NOT exponential — the spec
    // reserves doubling for connection failures. A setter would invite the
    // wrong rule; the method encodes the spec's.
    const grant = new Grant(record({ interval: 5 }));
    expect(grant.slowDown(0)).toBe(10);
    expect(grant.slowDown(0)).toBe(15);
  });

  it(`allows the first poll and only rate-limits the next`, () => {
    // WHY: penalizing the very first poll would slow every device for no
    // reason, since there is no previous poll to be too close to.
    const grant = new Grant(record({ interval: 5 }));
    expect(grant.pollingTooSoon(1000)).toBe(false);

    grant.markPolled(1000);
    expect(grant.pollingTooSoon(2000)).toBe(true);
    expect(grant.pollingTooSoon(6000)).toBe(false);
  });

  it(`round-trips through a store record`, () => {
    // WHY: stores persist `toJSON` output and rehydrate with `from`. If any
    // field were dropped, a grant would silently reset — losing its raised
    // interval, or worse, its approved subject.
    const grant = new Grant(record());
    grant.send({ type: `APPROVE`, subject: `did:plc:example` });
    grant.slowDown(500);

    const restored = Grant.from(grant.toJSON());
    expect(restored.state).toBe(`approved`);
    expect(restored.subject).toBe(`did:plc:example`);
    expect(restored.interval).toBe(10);
  });
});

const TERMINAL_POLL_STATES: PollState[] = [
  `authorized`,
  `denied`,
  `expired`,
  `aborted`
];

describe(`poll machine`, () => {
  it(`cycles between waiting and polling while the user decides`, () => {
    // WHY: these three responses all mean "keep going" and differ only in how
    // long the next wait is — which is context, not state.
    expect(pollTransition(`idle`, { type: `START` })).toBe(`waiting`);
    expect(pollTransition(`waiting`, { type: `TICK` })).toBe(`polling`);
    for (const event of [
      `AUTHORIZATION_PENDING`,
      `SLOW_DOWN`,
      `NETWORK_ERROR`
    ] as const) {
      expect(pollTransition(`polling`, { type: event })).toBe(`waiting`);
    }
  });

  it(`maps each RFC outcome to the screen the user should see`, () => {
    expect(pollTransition(`polling`, { type: `SUCCESS` })).toBe(`authorized`);
    expect(pollTransition(`polling`, { type: `ACCESS_DENIED` })).toBe(`denied`);
    expect(pollTransition(`polling`, { type: `EXPIRED_TOKEN` })).toBe(
      `expired`
    );
  });

  it(`can be aborted from any live state`, () => {
    // WHY: the screen can be dismissed at any moment. A live state that ignored
    // ABORT would leave the loop running against a screen nobody is watching.
    for (const state of [`idle`, `waiting`, `polling`] as const) {
      expect(pollTransition(state, { type: `ABORT` })).toBe(`aborted`);
    }
  });

  it(`refuses every event once settled`, () => {
    for (const state of TERMINAL_POLL_STATES) {
      expect(pollTransition(state, { type: `TICK` })).toBe(state);
      expect(pollTransition(state, { type: `SUCCESS` })).toBe(state);
      expect(isPollSettled(state)).toBe(true);
    }
  });

  it(`reports legality without applying the event`, () => {
    expect(canTransitionPoll(`waiting`, `TICK`)).toBe(true);
    expect(canTransitionPoll(`authorized`, `TICK`)).toBe(false);
  });
});

describe(`poll context`, () => {
  const context = (overrides: Partial<PollContext> = {}): PollContext => ({
    intervalSeconds: 5,
    deadline: 1_000_000,
    attempts: 0,
    ...overrides
  });

  it(`keeps the two interval rules distinct`, () => {
    // WHY: this is the single easiest thing to get wrong in RFC 8628.
    // `slow_down` is the server pacing us: fixed +5s. A network failure is
    // congestion: exponential. Conflating them either hammers a struggling
    // server or crawls when the server only asked for a small delay.
    expect(
      pollContextTransition(context({ intervalSeconds: 5 }), {
        type: `SLOW_DOWN`
      }).intervalSeconds
    ).toBe(10);

    expect(
      pollContextTransition(context({ intervalSeconds: 5 }), {
        type: `NETWORK_ERROR`
      }).intervalSeconds
    ).toBe(10);

    // They diverge as they compound: +5 stays linear, ×2 grows.
    expect(
      pollContextTransition(context({ intervalSeconds: 20 }), {
        type: `SLOW_DOWN`
      }).intervalSeconds
    ).toBe(25);

    expect(
      pollContextTransition(context({ intervalSeconds: 20 }), {
        type: `NETWORK_ERROR`
      }).intervalSeconds
    ).toBe(40);
  });

  it(`caps backoff so a long outage cannot stall the flow`, () => {
    // WHY: unbounded doubling would push the next poll past the code's own
    // lifetime, so a recovered network would never be noticed.
    expect(
      pollContextTransition(context({ intervalSeconds: 45 }), {
        type: `NETWORK_ERROR`
      }).intervalSeconds
    ).toBe(60);
  });

  it(`counts attempts for the UI without changing cadence`, () => {
    const next = pollContextTransition(context(), {
      type: `AUTHORIZATION_PENDING`
    });
    expect(next.attempts).toBe(1);
    expect(next.intervalSeconds).toBe(5);
  });

  it(`leaves the interval alone on terminal events`, () => {
    expect(
      pollContextTransition(context({ intervalSeconds: 5 }), {
        type: `SUCCESS`
      })
    ).toEqual(context({ intervalSeconds: 5 }));
  });
});

describe(`eventForTokenError`, () => {
  it(`treats a missing error field as success`, () => {
    expect(eventForTokenError(undefined)).toEqual({ type: `SUCCESS` });
  });

  it(`maps every spec error code verbatim`, () => {
    expect(eventForTokenError(`authorization_pending`)).toEqual({
      type: `AUTHORIZATION_PENDING`
    });
    expect(eventForTokenError(`slow_down`)).toEqual({ type: `SLOW_DOWN` });
    expect(eventForTokenError(`access_denied`)).toEqual({
      type: `ACCESS_DENIED`
    });
    expect(eventForTokenError(`expired_token`)).toEqual({
      type: `EXPIRED_TOKEN`
    });
  });

  it(`keeps polling on an unrecognized code`, () => {
    // WHY: a non-standard error (a proxy injecting `rate_limited`, say) is not
    // evidence the user decided anything. Reading it as success would sign the
    // device in on a garbage payload; reading it as denial would blame the user
    // for a broken endpoint.
    expect(eventForTokenError(`rate_limited`)).toEqual({
      type: `AUTHORIZATION_PENDING`
    });
  });
});
