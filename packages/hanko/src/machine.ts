/**
 * The device-authorization flow as two explicit state machines.
 *
 * Modeled the way xstate would model it — states, events, and a declarative
 * transition table — but hand-rolled on WinterTC primitives so the library
 * stays dependency-free. What we keep from that shape is the part that pays:
 * transitions are DATA, readable in one place and checkable against RFC 8628
 * side by side, rather than control flow scattered across functions.
 *
 * What we deliberately omit is the actor/service layer. Nothing here needs to
 * observe transitions from outside, and an interpreter abstraction for a
 * single consumer would be weight without benefit.
 *
 * Side effects live outside: these reducers are pure, and the classes in
 * `server.ts` / `client/index.ts` own the I/O and the state itself.
 */

/* ────────────────────────────  Grant machine  ──────────────────────────── */

/**
 * Server-side lifecycle of one authorization attempt.
 *
 * `pending` is the only non-terminal state. `consumed` is distinct from
 * `approved` because approval is not what ends the flow — redemption is. A
 * device_code that stayed redeemable after approval would be a replayable
 * bearer credential.
 */
export type GrantState =
  | `pending`
  | `approved`
  | `denied`
  | `expired`
  | `consumed`;

/** Events that can move a grant. */
export type GrantEvent =
  /** The user authorized on their phone. Carries who they are. */
  | { type: `APPROVE`; subject: string }
  /** The user refused. */
  | { type: `DENY` }
  /** The deadline passed. Raised on read, not by a timer — see `server.ts`. */
  | { type: `EXPIRE` }
  /** The device redeemed its approval. Terminal. */
  | { type: `REDEEM` };

/**
 * Transitions, as a table.
 *
 * Read this against RFC 8628 §3.3–3.5: every legal move is one entry, and
 * anything absent is illegal by construction. An event with no entry for the
 * current state is a no-op — which is what makes double-approval, approving an
 * expired grant, and re-redeeming a consumed one all impossible without a
 * scattering of guard clauses.
 */
const GRANT_TRANSITIONS: {
  readonly [S in GrantState]?: {
    readonly [E in GrantEvent[`type`]]?: GrantState;
  };
} = {
  pending: {
    APPROVE: `approved`,
    DENY: `denied`,
    EXPIRE: `expired`
  },
  // Approved grants still expire: an approval nobody collected before the
  // deadline must not stay redeemable indefinitely.
  approved: {
    REDEEM: `consumed`,
    EXPIRE: `expired`
  }
  // denied, expired, consumed: terminal. No entry, so no event moves them.
};

/** Whether `event` is legal in `state`. */
export const canTransitionGrant = (
  state: GrantState,
  event: GrantEvent[`type`]
): boolean => GRANT_TRANSITIONS[state]?.[event] !== undefined;

/**
 * Pure grant reducer. Returns the same state when the event is illegal, so
 * callers can compare identity to detect a rejected transition.
 */
export const grantTransition = (
  state: GrantState,
  event: GrantEvent
): GrantState => GRANT_TRANSITIONS[state]?.[event.type] ?? state;

/** Terminal states accept no further events. */
export const isGrantSettled = (state: GrantState): boolean =>
  GRANT_TRANSITIONS[state] === undefined;

/* ────────────────────────────  Poll machine  ───────────────────────────── */

/**
 * Device-side polling lifecycle.
 *
 * States mirror what the screen is doing, so a UI can render directly from
 * them: `waiting` is the gap between polls, `polling` is a request in flight.
 * The three terminal states are the outcomes the screen must show.
 */
export type PollState =
  | `idle`
  | `waiting`
  | `polling`
  | `authorized`
  | `denied`
  | `expired`
  | `aborted`;

/**
 * Events driving the poll loop.
 *
 * The four RFC error codes appear verbatim as event types so the mapping from
 * a token-endpoint response to a transition needs no translation layer.
 */
export type PollEvent =
  | { type: `START` }
  | { type: `TICK` }
  | { type: `AUTHORIZATION_PENDING` }
  | { type: `SLOW_DOWN` }
  | { type: `ACCESS_DENIED` }
  | { type: `EXPIRED_TOKEN` }
  /** A response with no `error` — the grant was redeemed. */
  | { type: `SUCCESS` }
  /** Network failure. Distinct from SLOW_DOWN: congestion, not policy. */
  | { type: `NETWORK_ERROR` }
  /** The client's own deadline elapsed. */
  | { type: `DEADLINE` }
  /** The screen was dismissed. */
  | { type: `ABORT` };

const POLL_TRANSITIONS: {
  readonly [S in PollState]?: { readonly [E in PollEvent[`type`]]?: PollState };
} = {
  idle: {
    START: `waiting`,
    ABORT: `aborted`
  },
  waiting: {
    TICK: `polling`,
    DEADLINE: `expired`,
    ABORT: `aborted`
  },
  polling: {
    // Back to waiting: these three mean "keep going", differing only in how
    // long the next wait is — which is context, not state.
    AUTHORIZATION_PENDING: `waiting`,
    SLOW_DOWN: `waiting`,
    NETWORK_ERROR: `waiting`,
    SUCCESS: `authorized`,
    ACCESS_DENIED: `denied`,
    EXPIRED_TOKEN: `expired`,
    DEADLINE: `expired`,
    ABORT: `aborted`
  }
  // authorized, denied, expired, aborted: terminal.
};

/**
 * Context carried alongside the poll state.
 *
 * Separate from the state itself, exactly as xstate separates finite state
 * from extended state: the interval changes constantly but is not a state —
 * `waiting` at 5s and `waiting` at 20s are the same state, different context.
 */
export interface PollContext {
  /** Current wait between polls, in seconds. */
  intervalSeconds: number;
  /** Epoch ms after which the flow is over regardless of the server. */
  deadline: number;
  /** Polls attempted. Useful for UI ("still waiting…") and diagnostics. */
  attempts: number;
}

export const canTransitionPoll = (
  state: PollState,
  event: PollEvent[`type`]
): boolean => POLL_TRANSITIONS[state]?.[event] !== undefined;

export const pollTransition = (state: PollState, event: PollEvent): PollState =>
  POLL_TRANSITIONS[state]?.[event.type] ?? state;

export const isPollSettled = (state: PollState): boolean =>
  POLL_TRANSITIONS[state] === undefined;

/**
 * Context reducer, pure and separate from the state reducer.
 *
 * The two interval rules live here together, which is the point: `SLOW_DOWN`
 * is a fixed +5s per RFC 8628 §3.5 ("increased by 5 seconds for this and all
 * subsequent requests"), while `NETWORK_ERROR` doubles. Conflating them is the
 * easy mistake, and side-by-side they cannot be confused.
 */
export const pollContextTransition = (
  context: PollContext,
  event: PollEvent
): PollContext => {
  switch (event.type) {
    case `SLOW_DOWN`:
      // Additive and sticky. Never reset on a later success.
      return {
        ...context,
        intervalSeconds: context.intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS,
        attempts: context.attempts + 1
      };
    case `NETWORK_ERROR`:
      // Exponential, capped. The spec recommends backoff for connection
      // failures specifically, as distinct from the server's pacing signal.
      return {
        ...context,
        intervalSeconds: Math.min(
          context.intervalSeconds * 2,
          MAX_BACKOFF_SECONDS
        ),
        attempts: context.attempts + 1
      };
    case `AUTHORIZATION_PENDING`:
      return { ...context, attempts: context.attempts + 1 };
    // Lifecycle and terminal events carry no cadence change: the interval a
    // flow ended on is not information anyone needs afterwards.
    case `START`:
    case `TICK`:
    case `SUCCESS`:
    case `ACCESS_DENIED`:
    case `EXPIRED_TOKEN`:
    case `DEADLINE`:
    case `ABORT`:
      return context;
  }
};

/** RFC 8628 §3.5: `slow_down` adds exactly this many seconds, permanently. */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Ceiling for network backoff, so a long outage cannot stall the flow. */
export const MAX_BACKOFF_SECONDS = 60;

/**
 * Map a token-endpoint response's `error` field to a poll event.
 *
 * `undefined` means success. An unrecognized code maps to
 * `AUTHORIZATION_PENDING` rather than success or failure: an unknown code is
 * not evidence the user decided anything, and the deadline still bounds the
 * loop. Treating it as success would sign the device in on a garbage payload.
 */
export const eventForTokenError = (error: string | undefined): PollEvent => {
  switch (error) {
    case undefined:
      return { type: `SUCCESS` };
    case `authorization_pending`:
      return { type: `AUTHORIZATION_PENDING` };
    case `slow_down`:
      return { type: `SLOW_DOWN` };
    case `access_denied`:
      return { type: `ACCESS_DENIED` };
    case `expired_token`:
      return { type: `EXPIRED_TOKEN` };
    default:
      return { type: `AUTHORIZATION_PENDING` };
  }
};

/* ──────────────────────────  Approval machine  ─────────────────────────── */

/**
 * The approving device's lifecycle — the third participant in the flow.
 *
 * Runs on the phone that is ALREADY authenticated. Two ways in, as the
 * ecosystem shows: Plex hands the OS camera a URL and the user lands in a
 * browser (`scanning` is skipped, the code arrives from the query string),
 * while Discord and Steam scan inside their own app and never leave it.
 *
 * `confirming` exists because approving must not be one tap on an unverified
 * code. RFC 8628 §5.4 asks the user to check that the code matches the screen
 * in front of them; that check is the only defense against a phished QR
 * pointing at an attacker's device.
 */
export type ApprovalState =
  | `idle`
  /** Camera open, looking for a code. Skipped when arriving by URL. */
  | `scanning`
  /** A code was read or typed; asking the server what it belongs to. */
  | `resolving`
  /** Server knows the grant. Running the challenge before approve/deny. */
  | `confirming`
  /** Sending the decision. */
  | `submitting`
  | `approved`
  | `denied`
  /** The grant was already expired, consumed, or unknown. */
  | `invalid`
  /** Camera or network failure. Recoverable — the user can retry. */
  | `failed`;

export type ApprovalEvent =
  /** Open the scanner (in-app path). */
  | { type: `SCAN` }
  /** A code arrived — scanned, typed, or read from the URL. */
  | { type: `CODE`; userCode: string }
  /** The server resolved the code to a live grant. */
  | { type: `RESOLVED` }
  /** The server did not recognize the code, or it is no longer live. */
  | { type: `REJECTED` }
  /** The challenge passed — the user proved they are looking at the screen. */
  | { type: `CONFIRMED` }
  /** The challenge failed. Back to confirming so the user can retry. */
  | { type: `CHALLENGE_FAILED` }
  /** The user chose to approve. */
  | { type: `APPROVE` }
  /** The user chose to refuse. */
  | { type: `DENY` }
  /** The server accepted the decision. */
  | { type: `SUBMITTED`; approved: boolean }
  /** Camera or network failure. */
  | { type: `ERROR` }
  /** Start over after a failure or an invalid code. */
  | { type: `RESET` };

const APPROVAL_TRANSITIONS: {
  readonly [S in ApprovalState]?: {
    readonly [E in ApprovalEvent[`type`]]?: ApprovalState;
  };
} = {
  idle: {
    SCAN: `scanning`,
    // No SCAN first: this is the Plex path, where the code came from the URL
    // and there is no camera step at all.
    CODE: `resolving`
  },
  scanning: {
    CODE: `resolving`,
    ERROR: `failed`,
    RESET: `idle`
  },
  resolving: {
    RESOLVED: `confirming`,
    REJECTED: `invalid`,
    ERROR: `failed`
  },
  confirming: {
    CONFIRMED: `confirming`,
    // Stays put: a wrong code or a failed biometric is a retry, not a dead
    // end. The host decides how many attempts to allow.
    CHALLENGE_FAILED: `confirming`,
    APPROVE: `submitting`,
    DENY: `submitting`,
    RESET: `idle`
  },
  submitting: {
    SUBMITTED: `approved`,
    ERROR: `failed`
  },
  failed: {
    RESET: `idle`
  },
  invalid: {
    RESET: `idle`
  }
  // approved, denied: terminal.
};

export const canTransitionApproval = (
  state: ApprovalState,
  event: ApprovalEvent[`type`]
): boolean => APPROVAL_TRANSITIONS[state]?.[event] !== undefined;

/**
 * Pure approval reducer.
 *
 * `SUBMITTED` is the one event whose target depends on its payload — the same
 * transition lands on `approved` or `denied` according to what the user chose,
 * so the table's entry is overridden here.
 */
export const approvalTransition = (
  state: ApprovalState,
  event: ApprovalEvent
): ApprovalState => {
  if (event.type === `SUBMITTED` && state === `submitting`) {
    return event.approved ? `approved` : `denied`;
  }
  return APPROVAL_TRANSITIONS[state]?.[event.type] ?? state;
};

export const isApprovalSettled = (state: ApprovalState): boolean =>
  APPROVAL_TRANSITIONS[state] === undefined;
