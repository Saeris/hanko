/**
 * A scan session, as a state machine.
 *
 * Modeled the way `machine.ts` models the device flow: states, events, and a
 * declarative transition table, hand-rolled so this stays dependency-free.
 *
 * Deliberately NOT applied to the decode pipeline itself. Binarize → locate →
 * extract → decode is a fallible sequential pipeline, not a machine: each
 * stage runs once per frame and either produces a value or does not. Modeling
 * it as states would add ceremony without making a single illegal move
 * impossible, which is the only thing a transition table buys.
 *
 * What IS a machine is the session around it — permission, camera lifecycle,
 * pause and resume — and that part is identical whether the frames are being
 * searched for a QR, a DataMatrix, or an Aztec code. So it lives here,
 * symbology-agnostic, and the decoders plug into it.
 */

/**
 * Lifecycle of one scanning session.
 *
 * `scanning` is the only state that consumes frames. `decoded` is terminal
 * rather than a return to `scanning`: a scanner that kept reading after a
 * successful decode would fire twice on the same symbol, and every consumer
 * would have to debounce it. Restarting is explicit.
 *
 * `denied` is separate from `failed` because they are different conversations
 * with the user — one asks them to change a browser setting, the other is a
 * fault they cannot act on. Collapsing them is how a permission prompt ends up
 * reported as "something went wrong".
 */
export type ScanState =
  | `idle`
  | `starting`
  | `scanning`
  | `paused`
  | `decoded`
  | `denied`
  | `failed`
  | `stopped`;

/** Why a scan session ended without a result. */
export type ScanFailure =
  /** No camera on this device, or none matching the requested facing mode. */
  | `no-camera`
  /** The page is not a secure context, so `getUserMedia` is unavailable. */
  | `insecure-context`
  /** The camera was lost mid-session — unplugged, or claimed by another app. */
  | `camera-lost`
  /** The decoder itself threw. Distinct from "no code in this frame". */
  | `decoder-error`;

/** Events driving a scan session. */
export type ScanEvent =
  /** Consumer asked to begin. */
  | { type: `START` }
  /** Camera acquired and frames are flowing. */
  | { type: `READY` }
  /** A frame decoded successfully. Terminal — restarting is explicit. */
  | { type: `DECODE`; value: string }
  /** The user refused camera access. */
  | { type: `DENY` }
  /** Something broke that the user cannot act on. */
  | { type: `FAIL`; reason: ScanFailure }
  /** Tab hidden, or the consumer suspended scanning. */
  | { type: `PAUSE` }
  /** Visible again. */
  | { type: `RESUME` }
  /** Consumer tore the session down. */
  | { type: `STOP` };

/**
 * Transitions, as a table.
 *
 * Everything absent is illegal by construction. That is what makes a `DECODE`
 * arriving after `STOP` a no-op rather than a race — a real hazard here,
 * because a decode in flight when the camera stops would otherwise resolve
 * into a torn-down session.
 */
const SCAN_TRANSITIONS: {
  readonly [S in ScanState]?: {
    readonly [E in ScanEvent[`type`]]?: ScanState;
  };
} = {
  idle: {
    START: `starting`
  },
  // Permission is resolved here, so this is the only state that can be denied.
  starting: {
    READY: `scanning`,
    DENY: `denied`,
    FAIL: `failed`,
    STOP: `stopped`
  },
  scanning: {
    DECODE: `decoded`,
    PAUSE: `paused`,
    FAIL: `failed`,
    STOP: `stopped`
  },
  // No DECODE here: a paused session is not reading frames, and accepting one
  // would mean a frame queued before the pause could resolve after it.
  paused: {
    RESUME: `scanning`,
    FAIL: `failed`,
    STOP: `stopped`
  }
};

/** Whether `event` would move `state`. */
export const canTransitionScan = (
  state: ScanState,
  event: ScanEvent[`type`]
): boolean => SCAN_TRANSITIONS[state]?.[event] !== undefined;

/** Apply an event. Unknown events for the current state are no-ops. */
export const scanTransition = (state: ScanState, event: ScanEvent): ScanState =>
  SCAN_TRANSITIONS[state]?.[event.type] ?? state;

/**
 * Terminal states accept no further events.
 *
 * Derived from the table rather than listed, so a new state cannot be added
 * without its terminality following automatically.
 */
export const isScanSettled = (state: ScanState): boolean =>
  SCAN_TRANSITIONS[state] === undefined;
