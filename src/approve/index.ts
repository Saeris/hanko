/**
 * The approving device's client — the third participant.
 *
 * Runs on the already-authenticated phone. UI-agnostic by design: it exposes
 * state and lifecycle hooks rather than components, so React, Vue, Svelte,
 * Solid, and React Native each bind it with their own conventions. Nothing
 * here touches the DOM.
 *
 * Covers both topologies the ecosystem uses:
 *
 * - **Plex**: the OS camera opens a URL. Call `submitCode` with the code from
 *   the query string; there is no scanning step.
 * - **Discord / Steam**: the app scans in-place. Call `scan` with frames from
 *   your camera; the user never leaves the app.
 */

import {
  approvalTransition,
  isApprovalSettled,
  type ApprovalEvent,
  type ApprovalState
} from "../machine.js";
import {
  parseScannedCode,
  type CameraFrame,
  type QrScanner
} from "../scanner.js";
import { noChallenge, type ChallengeStrategy } from "../challenge.js";

/** What the approval endpoint tells us about a code. */
export interface ResolvedGrant {
  /** The code, as the server has it. Display this for the user to check. */
  userCode: string;
  /** Optional detail a host may show: which client is asking, and for what. */
  clientId?: string;
  scope?: string;
}

export interface ApprovalHooks {
  /** Any successful transition. The main binding point for a UI. */
  onTransition?: (from: ApprovalState, to: ApprovalState) => void;
  /** A code was read. Fires before the server is asked about it. */
  onCode?: (userCode: string) => void;
  /** The server resolved the code. Carries what to show the user. */
  onResolved?: (grant: ResolvedGrant, prompt: unknown) => void;
  /** The challenge was answered incorrectly. The user may retry. */
  onChallengeFailed?: (reason: string | undefined, attempts: number) => void;
  /** Terminal: the decision was recorded. */
  onSettled?: (state: ApprovalState) => void;
  /** Recoverable failure — camera or network. */
  onError?: (error: unknown, state: ApprovalState) => void;
}

export interface ApprovalClientOptions {
  /** Resolve a code to a grant. Usually `GET /link?user_code=…`. */
  resolve: (userCode: string) => Promise<ResolvedGrant | null>;
  /** Record the decision. Usually `POST /link`. */
  submit: (userCode: string, approved: boolean) => Promise<void>;
  /**
   * How the user proves they are looking at the requesting screen.
   *
   * Defaults to {@link noChallenge} — one tap, what Discord and Steam ship.
   * For a public screen prefer `codeEntryChallenge` or `tripletChallenge`,
   * which is what RFC 8628 §5.4 actually asks for.
   */
  challenge?: ChallengeStrategy;
  /** Needed only for the in-app scanning path. */
  scanner?: QrScanner;
  /** Query parameter carrying the code in scanned URLs. */
  codeParam?: string;
  hooks?: ApprovalHooks;
}

export class ApprovalClient {
  readonly #resolve: (userCode: string) => Promise<ResolvedGrant | null>;
  readonly #submit: (userCode: string, approved: boolean) => Promise<void>;
  readonly #challenge: ChallengeStrategy;
  readonly #scanner: QrScanner | undefined;
  readonly #codeParam: string;
  readonly #hooks: ApprovalHooks;

  #state: ApprovalState = `idle`;
  #grant: ResolvedGrant | undefined;
  #prompt: unknown;
  #challengePassed = false;
  #challengeAttempts = 0;

  constructor({
    resolve,
    submit,
    challenge = noChallenge(),
    scanner,
    codeParam = `user_code`,
    hooks = {}
  }: ApprovalClientOptions) {
    this.#resolve = resolve;
    this.#submit = submit;
    this.#challenge = challenge;
    this.#scanner = scanner;
    this.#codeParam = codeParam;
    this.#hooks = hooks;
  }

  get state(): ApprovalState {
    return this.#state;
  }

  get settled(): boolean {
    return isApprovalSettled(this.#state);
  }

  /** The resolved grant, once known. Show its code for the user to verify. */
  get grant(): ResolvedGrant | undefined {
    return this.#grant;
  }

  /** Whatever the challenge wants rendered — triplet choices, a prompt kind. */
  get challengePrompt(): unknown {
    return this.#prompt;
  }

  get challengeKind(): string {
    return this.#challenge.kind;
  }

  /** Whether the challenge has been satisfied, so approval may proceed. */
  get confirmed(): boolean {
    return this.#challengePassed;
  }

  #send(event: ApprovalEvent): boolean {
    const from = this.#state;
    const to = approvalTransition(from, event);
    if (to === from) return false;

    this.#state = to;
    this.#hooks.onTransition?.(from, to);
    if (isApprovalSettled(to)) this.#hooks.onSettled?.(to);
    return true;
  }

  /** Open the scanner (in-app path). */
  startScanning(): void {
    this.#send({ type: `SCAN` });
  }

  /**
   * Offer a camera frame to the scanner.
   *
   * Returns the code when this frame contained one. Call it per frame and
   * ignore the nulls — a camera pointed at a room sees unrelated codes
   * constantly, and each is a non-event rather than an error.
   */
  async scan(source: CameraFrame): Promise<string | null> {
    if (!this.#scanner) throw new Error(`no scanner configured`);
    if (this.#state !== `scanning`) return null;

    let detected;
    try {
      detected = await this.#scanner.detect(source);
    } catch (error) {
      this.#send({ type: `ERROR` });
      this.#hooks.onError?.(error, this.#state);
      return null;
    }

    for (const { rawValue } of detected) {
      const payload = parseScannedCode(rawValue, { param: this.#codeParam });
      if (payload) {
        await this.submitCode(payload.userCode);
        return payload.userCode;
      }
    }
    return null;
  }

  /**
   * Hand over a code from the URL (Plex path) or a manual entry field.
   *
   * The same entry point as a successful scan, so both topologies converge on
   * one flow from here.
   */
  async submitCode(userCode: string): Promise<boolean> {
    if (!this.#send({ type: `CODE`, userCode })) return false;
    this.#hooks.onCode?.(userCode);

    let resolved: ResolvedGrant | null;
    try {
      resolved = await this.#resolve(userCode);
    } catch (error) {
      this.#send({ type: `ERROR` });
      this.#hooks.onError?.(error, this.#state);
      return false;
    }

    if (!resolved) {
      this.#send({ type: `REJECTED` });
      return false;
    }

    this.#grant = resolved;
    // Prompt built from the SERVER's code, not the scanned one: a triplet
    // built from an attacker-supplied string would present decoys around a
    // code that is not the one being authorized.
    this.#prompt = this.#challenge.present(resolved.userCode);
    this.#challengePassed = false;
    this.#challengeAttempts = 0;
    this.#send({ type: `RESOLVED` });
    this.#hooks.onResolved?.(resolved, this.#prompt);
    return true;
  }

  /**
   * Answer the confirmation challenge.
   *
   * Separate from {@link approve} so a UI can verify as the user types (or as
   * a biometric returns) and enable the approve button only once it passes.
   */
  async confirm(answer?: unknown): Promise<boolean> {
    if (this.#state !== `confirming` || !this.#grant) return false;

    const result = await this.#challenge.verify(answer, this.#grant.userCode);
    this.#challengeAttempts += 1;

    if (!result.ok) {
      this.#challengePassed = false;
      this.#send({ type: `CHALLENGE_FAILED` });
      this.#hooks.onChallengeFailed?.(result.reason, this.#challengeAttempts);
      return false;
    }

    this.#challengePassed = true;
    this.#send({ type: `CONFIRMED` });
    return true;
  }

  /**
   * Approve the sign-in.
   *
   * Refuses while the challenge is unsatisfied. That guard is the point of the
   * challenge existing: a UI bug that wires the button straight to this method
   * must not be able to skip the check.
   */
  async approve(): Promise<boolean> {
    if (!this.#challengePassed) return false;
    return this.#decide(true);
  }

  /**
   * Refuse the sign-in.
   *
   * Deliberately NOT gated on the challenge. A user who cannot confirm a code
   * is exactly the user most likely to be looking at a phishing attempt, and
   * they must always be able to say no.
   */
  async deny(): Promise<boolean> {
    return this.#decide(false);
  }

  async #decide(approved: boolean): Promise<boolean> {
    if (!this.#grant) return false;
    if (!this.#send({ type: approved ? `APPROVE` : `DENY` })) return false;

    try {
      await this.#submit(this.#grant.userCode, approved);
    } catch (error) {
      this.#send({ type: `ERROR` });
      this.#hooks.onError?.(error, this.#state);
      return false;
    }

    this.#send({ type: `SUBMITTED`, approved });
    return true;
  }

  /** Start over after a failure or an unrecognized code. */
  reset(): void {
    this.#grant = undefined;
    this.#prompt = undefined;
    this.#challengePassed = false;
    this.#challengeAttempts = 0;
    this.#send({ type: `RESET` });
  }
}

export {
  allOf,
  codeEntryChallenge,
  noChallenge,
  platformChallenge,
  tripletChallenge
} from "../challenge.js";
export type {
  ChallengeResult,
  ChallengeStrategy,
  TripletPrompt
} from "../challenge.js";
export {
  createBarcodeDetectorScanner,
  hasNativeBarcodeDetector,
  parseScannedCode
} from "../scanner.js";
export type {
  CameraFrame,
  DetectedBarcode,
  QrScanner,
  ScannedPayload
} from "../scanner.js";

export {
  appleAppSiteAssociation,
  buildApprovalUrl,
  buildAppSchemeUrl,
  consumeLaunchTarget,
  digitalAssetLinks,
  expoLinkingConfig,
  parseApprovalLink,
  pwaLaunchHandler
} from "../linking.js";
export type { LinkConfig, LinkSource, ParsedApprovalLink } from "../linking.js";
