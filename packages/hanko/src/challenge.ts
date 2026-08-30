/**
 * Confirmation challenges for the approving device.
 *
 * RFC 8628 §5.4: the approval screen SHOULD show the code and ask the user to
 * verify it matches the device in front of them. Scanning a QR skips the
 * typing, which also skips the moment where the user would have noticed the
 * code was wrong — so the check has to be reintroduced deliberately.
 *
 * How much friction that check deserves is a product decision, not a protocol
 * one. Discord and Steam ship a bare "Approve?"; GitHub's sudo flow makes you
 * type a code; Google shows three numbers and asks you to pick the one on the
 * other screen. All are legitimate for different risk levels, so the strategy
 * is pluggable and the machine only cares whether it passed.
 *
 * These run on the ALREADY AUTHENTICATED device. They do not authenticate the
 * user — they establish that the user can see the screen requesting access.
 */

import { normalizeUserCode } from "./codes.js";

/** Outcome of a challenge attempt. */
export interface ChallengeResult {
  ok: boolean;
  /** Present when `ok` is false, for a precise message. */
  reason?: `mismatch` | `cancelled` | `unavailable`;
}

/**
 * A confirmation strategy.
 *
 * `present` gives the UI whatever it needs to render (the decoys for a
 * triplet, say); `verify` checks the user's answer. Async because a biometric
 * or WebAuthn prompt is inherently asynchronous.
 */
export interface ChallengeStrategy<TPrompt = unknown, TAnswer = unknown> {
  /** Stable name, so a UI can switch on which challenge it is rendering. */
  readonly kind: string;
  /** What the UI should show. Called once per confirmation. */
  present(userCode: string): TPrompt;
  /** Check the user's answer. */
  verify(answer: TAnswer, userCode: string): Promise<ChallengeResult>;
}

/**
 * No challenge — approving is a single tap.
 *
 * What Discord and Steam ship. Appropriate when the QR was scanned inside your
 * own authenticated app, which already proves possession of the phone. Note
 * this is weaker than RFC 8628 §5.4 asks for: nothing stops a user approving a
 * code they never actually looked at.
 */
export const noChallenge = (): ChallengeStrategy<null, void> => ({
  kind: `none`,
  present: () => null,
  verify: async () => Promise.resolve({ ok: true })
});

/**
 * The user types the code shown on the device.
 *
 * The RFC's own suggestion, and GitHub's sudo pattern. Highest friction,
 * strongest guarantee: an attacker who phished the QR cannot supply a code the
 * user can read off their own screen.
 */
export const codeEntryChallenge = (): ChallengeStrategy<
  { kind: `code-entry` },
  string
> => ({
  kind: `code-entry`,
  present: () => ({ kind: `code-entry` }),
  verify: async (answer, userCode) =>
    Promise.resolve(
      // Normalized on both sides: the user is retyping from a screen, so
      // spacing, case, and the separator must not matter.
      normalizeUserCode(answer) === normalizeUserCode(userCode)
        ? { ok: true }
        : { ok: false, reason: `mismatch` }
    )
});

/** What a triplet challenge hands the UI. */
export interface TripletPrompt {
  kind: `triplet`;
  /** The real code plus decoys, already shuffled. Render as-is. */
  choices: string[];
}

/**
 * The user picks the real code from a small set of decoys.
 *
 * Google's mobile approval pattern. Most of code-entry's guarantee at a
 * fraction of the friction — one tap instead of eight keystrokes — which
 * matters on a phone. A wrong pick is a real signal: the user is not looking
 * at the device they are authorizing.
 */
export const tripletChallenge = ({
  decoys = 2,
  generate,
  shuffle = defaultShuffle
}: {
  /** Decoys alongside the real code. Two gives the classic three-up. */
  decoys?: number;
  /** Produces a decoy. Must match the real code's shape to be plausible. */
  generate: () => string;
  /** Injectable for deterministic tests. */
  shuffle?: <T>(items: T[]) => T[];
} & { generate: () => string }): ChallengeStrategy<TripletPrompt, string> => ({
  kind: `triplet`,
  present: (userCode) => {
    const choices = new Set<string>([normalizeUserCode(userCode)]);
    // Set-based with a bounded retry: a generator that happens to emit the
    // real code (or a duplicate) would otherwise render two identical
    // choices, which is unanswerable.
    for (
      let attempt = 0;
      choices.size <= decoys && attempt < decoys * 10;
      attempt++
    ) {
      choices.add(normalizeUserCode(generate()));
    }
    return { kind: `triplet`, choices: shuffle([...choices]) };
  },
  verify: async (answer, userCode) =>
    Promise.resolve(
      normalizeUserCode(answer) === normalizeUserCode(userCode)
        ? { ok: true }
        : { ok: false, reason: `mismatch` }
    )
});

/**
 * Delegate to something the platform provides — FaceID, Touch ID, WebAuthn, a
 * device passcode.
 *
 * hanko cannot implement these: they are platform APIs with no common
 * interface. What it can do is give them a slot in the same machine, so a host
 * that has one is not forced outside the flow to use it.
 *
 * A biometric proves possession of the phone, NOT that the user looked at the
 * device screen — so for a public taproom TV, pair it with `codeEntry` or
 * `triplet` rather than using it alone.
 */
export const platformChallenge = ({
  kind = `platform`,
  authenticate
}: {
  kind?: string;
  /** Resolves true when the platform accepted the user. */
  authenticate: (userCode: string) => Promise<boolean>;
}): ChallengeStrategy<{ kind: string }, void> => ({
  kind,
  present: () => ({ kind }),
  verify: async (_answer, userCode) => {
    try {
      return (await authenticate(userCode))
        ? { ok: true }
        : { ok: false, reason: `cancelled` };
    } catch {
      // A missing or broken platform API must not read as a refusal — the host
      // can fall back to another challenge.
      return { ok: false, reason: `unavailable` };
    }
  }
});

/**
 * Require several challenges in order.
 *
 * The composition that makes sense in practice: a biometric proves the phone,
 * a code check proves the screen. Neither alone covers both.
 *
 * Short-circuits on the first failure, and its `present` returns every prompt
 * so a UI can render them as steps.
 */
export const allOf = (
  strategies: ChallengeStrategy[]
): ChallengeStrategy<unknown[], unknown[]> => ({
  kind: `all-of`,
  present: (userCode) => strategies.map((s) => s.present(userCode)),
  verify: async (answers, userCode) => {
    for (const [index, strategy] of strategies.entries()) {
      const result = await strategy.verify(answers[index], userCode);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
});

/**
 * Fisher-Yates over a copy.
 *
 * Not `sort(() => Math.random() - 0.5)`, which is biased — with three choices
 * the real code would land in one position noticeably more often, and a user
 * who learned that could pass the challenge without reading anything.
 */
const defaultShuffle = <T>(items: T[]): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
