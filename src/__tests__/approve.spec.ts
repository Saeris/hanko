import { describe, expect, it, vi } from "vitest";
import {
  ApprovalClient,
  type ApprovalHooks,
  type ResolvedGrant
} from "../approve/index.js";
import {
  allOf,
  codeEntryChallenge,
  noChallenge,
  platformChallenge,
  tripletChallenge
} from "../challenge.js";
import { parseScannedCode } from "../scanner.js";
import type { QrScanner } from "../scanner.js";

const GRANT: ResolvedGrant = { userCode: `WDJB-MJHT`, clientId: `taproom-tv` };

const setup = (
  options: Partial<ConstructorParameters<typeof ApprovalClient>[0]> = {}
) => {
  const submit = vi.fn<(userCode: string, approved: boolean) => Promise<void>>(
    async () => {
      await Promise.resolve();
    }
  );
  const client = new ApprovalClient({
    resolve: async () => Promise.resolve(GRANT),
    submit,
    ...options
  });
  return { client, submit };
};

describe(`approval client`, () => {
  it(`takes a code straight from a URL without scanning`, async () => {
    // WHY: this is the Plex path — the OS camera opens a link and the code
    // arrives in the query string. Requiring a scan step first would make that
    // topology impossible to express.
    const { client } = setup();
    expect(client.state).toBe(`idle`);

    await client.submitCode(`WDJB-MJHT`);
    expect(client.state).toBe(`confirming`);
    expect(client.grant).toEqual(GRANT);
  });

  it(`reaches the same place by scanning in-app`, async () => {
    // WHY: Discord and Steam scan inside their own app and never leave it.
    // Both topologies must converge on one confirmation flow, or every host
    // implements the security-sensitive half twice.
    const scanner: QrScanner = {
      detect: async () =>
        Promise.resolve([
          { rawValue: `https://example.com/link?user_code=WDJB-MJHT` }
        ])
    };
    const { client } = setup({ scanner });

    client.startScanning();
    expect(client.state).toBe(`scanning`);

    await expect(client.scan({})).resolves.toBe(`WDJB-MJHT`);
    expect(client.state).toBe(`confirming`);
  });

  it(`ignores frames with no code`, async () => {
    // WHY: a camera pointed at a room sees unrelated codes constantly. Each
    // miss is a non-event — treating one as an error would abort the flow every
    // time the user's hand wobbled.
    const scanner: QrScanner = {
      detect: async () => Promise.resolve([])
    };
    const { client } = setup({ scanner });
    client.startScanning();

    await expect(client.scan({})).resolves.toBeNull();
    expect(client.state).toBe(`scanning`);
  });

  it(`marks an unknown code invalid rather than failing`, async () => {
    // WHY: a typo and a phishing attempt look identical here. `invalid` is
    // recoverable via reset; `failed` would suggest the app broke.
    const { client } = setup({
      resolve: async () => Promise.resolve(null)
    });

    await client.submitCode(`ZZZZ-ZZZZ`);
    expect(client.state).toBe(`invalid`);

    client.reset();
    expect(client.state).toBe(`idle`);
  });

  it(`refuses to approve before the challenge passes`, async () => {
    // WHY: THE central guard. A UI that wires its button straight to approve()
    // must not be able to skip the check RFC 8628 §5.4 asks for — otherwise the
    // challenge is decorative.
    const { client, submit } = setup({ challenge: codeEntryChallenge() });
    await client.submitCode(`WDJB-MJHT`);

    await expect(client.approve()).resolves.toBe(false);
    expect(submit).not.toHaveBeenCalled();

    await client.confirm(`WDJB-MJHT`);
    await expect(client.approve()).resolves.toBe(true);
    expect(submit).toHaveBeenCalledWith(`WDJB-MJHT`, true);
    expect(client.state).toBe(`approved`);
  });

  it(`always allows denial, challenge or not`, async () => {
    // WHY: a user who cannot confirm the code is exactly the user most likely
    // to be looking at a phishing attempt. Gating "no" behind a challenge they
    // are failing would trap them.
    const { client, submit } = setup({ challenge: codeEntryChallenge() });
    await client.submitCode(`WDJB-MJHT`);

    await expect(client.deny()).resolves.toBe(true);
    expect(submit).toHaveBeenCalledWith(`WDJB-MJHT`, false);
    expect(client.state).toBe(`denied`);
  });

  it(`lets the user retry a failed challenge`, async () => {
    // WHY: mistyping is normal. A wrong answer must not burn the grant — the
    // user should be able to look back at the screen and try again.
    const onChallengeFailed =
      vi.fn<NonNullable<ApprovalHooks[`onChallengeFailed`]>>();
    const { client } = setup({
      challenge: codeEntryChallenge(),
      hooks: { onChallengeFailed }
    });
    await client.submitCode(`WDJB-MJHT`);

    await expect(client.confirm(`WRONG`)).resolves.toBe(false);
    expect(client.state).toBe(`confirming`);
    expect(onChallengeFailed).toHaveBeenCalledWith(`mismatch`, 1);

    await expect(client.confirm(`wdjb mjht`)).resolves.toBe(true);
  });

  it(`reports transitions so a UI can render from state alone`, async () => {
    // WHY: the library ships no components. Hooks are the entire integration
    // surface for React, Vue, Svelte, and React Native alike.
    const onTransition = vi.fn<NonNullable<ApprovalHooks[`onTransition`]>>();
    const { client } = setup({ hooks: { onTransition } });

    await client.submitCode(`WDJB-MJHT`);
    await client.confirm();
    await client.approve();

    expect(onTransition.mock.calls.map(([, to]) => to)).toEqual([
      `resolving`,
      `confirming`,
      `submitting`,
      `approved`
    ]);
  });

  it(`recovers from a network failure`, async () => {
    // WHY: venue wifi drops. The user must be able to retry rather than being
    // told their code was rejected.
    const onError = vi.fn<NonNullable<ApprovalHooks[`onError`]>>();
    const { client } = setup({
      resolve: async () => Promise.reject(new Error(`offline`)),
      hooks: { onError }
    });

    await client.submitCode(`WDJB-MJHT`);
    expect(client.state).toBe(`failed`);
    // The error itself must reach the hook — a host needs it to distinguish
    // "offline, retry" from a genuine rejection.
    expect(onError).toHaveBeenCalledWith(expect.any(Error), `failed`);

    client.reset();
    expect(client.state).toBe(`idle`);
  });
});

describe(`challenges`, () => {
  it(`accepts a bare tap when no challenge is configured`, async () => {
    // WHY: what Discord and Steam ship. Weaker than the RFC asks for, but
    // legitimate when the scan happened inside an already-authenticated app.
    const strategy = noChallenge();
    await expect(strategy.verify(undefined, `WDJB-MJHT`)).resolves.toEqual({
      ok: true
    });
  });

  it(`compares typed codes ignoring case, spacing, and separators`, async () => {
    // WHY: the user is retyping from a TV across the room onto a phone
    // keyboard that autocorrects. Rejecting `wdjb mjht` would fail a user who
    // did everything right.
    const strategy = codeEntryChallenge();
    await expect(strategy.verify(`wdjb mjht`, `WDJB-MJHT`)).resolves.toEqual({
      ok: true
    });
    await expect(strategy.verify(`WDJB-MJHX`, `WDJB-MJHT`)).resolves.toEqual({
      ok: false,
      reason: `mismatch`
    });
  });

  it(`builds a triplet containing the real code exactly once`, () => {
    // WHY: a duplicate would make the challenge unanswerable, and a generator
    // that happened to emit the real code would do exactly that.
    let counter = 0;
    const strategy = tripletChallenge({
      generate: () =>
        [`WDJBMJHT`, `AAAAAAAA`, `BBBBBBBB`][counter++] ?? `CCCCCCCC`,
      shuffle: (items) => items
    });

    const prompt = strategy.present(`WDJB-MJHT`);
    expect(prompt.choices).toHaveLength(3);
    expect(prompt.choices.filter((c) => c === `WDJBMJHT`)).toHaveLength(1);
  });

  it(`only accepts the real code from a triplet`, async () => {
    const strategy = tripletChallenge({ generate: () => `AAAAAAAA` });
    await expect(strategy.verify(`WDJB-MJHT`, `WDJB-MJHT`)).resolves.toEqual({
      ok: true
    });
    await expect(strategy.verify(`AAAAAAAA`, `WDJB-MJHT`)).resolves.toEqual({
      ok: false,
      reason: `mismatch`
    });
  });

  it(`distinguishes a refused biometric from an unavailable one`, async () => {
    // WHY: a phone without FaceID must fall back to another challenge. If a
    // missing API read as a refusal, those users could never approve anything.
    const refused = platformChallenge({
      authenticate: async () => Promise.resolve(false)
    });
    await expect(refused.verify(undefined, `X`)).resolves.toEqual({
      ok: false,
      reason: `cancelled`
    });

    const broken = platformChallenge({
      authenticate: async () => Promise.reject(new Error(`no API`))
    });
    await expect(broken.verify(undefined, `X`)).resolves.toEqual({
      ok: false,
      reason: `unavailable`
    });
  });

  it(`requires every strategy in a composition`, async () => {
    // WHY: a biometric proves the phone; a code check proves the screen.
    // Composing them is the only way to cover both, so a short-circuit on the
    // first failure must not let the second be skipped.
    const strategy = allOf([
      platformChallenge({
        authenticate: async () => Promise.resolve(true)
      }),
      codeEntryChallenge()
    ]);

    await expect(
      strategy.verify([undefined, `WDJB-MJHT`], `WDJB-MJHT`)
    ).resolves.toEqual({
      ok: true
    });
    await expect(
      strategy.verify([undefined, `WRONG`], `WDJB-MJHT`)
    ).resolves.toEqual({
      ok: false,
      reason: `mismatch`
    });
  });
});

describe(`parseScannedCode`, () => {
  it(`reads the code out of a verification URL`, () => {
    expect(
      parseScannedCode(`https://example.com/link?user_code=WDJB-MJHT`)
    ).toEqual({
      userCode: `WDJB-MJHT`,
      verificationUri: `https://example.com/link?user_code=WDJB-MJHT`
    });
  });

  it(`falls back to the last path segment`, () => {
    // WHY: some hosts put the code in the path rather than the query. Both are
    // reasonable route designs, and a scanner that only understood one would
    // silently fail against the other.
    expect(
      parseScannedCode(`https://example.com/link/WDJB-MJHT`)?.userCode
    ).toBe(`WDJB-MJHT`);
  });

  it(`does not read the route itself as a code`, () => {
    // WHY: a single-segment URL is a ROUTE, not a code carrier. Reading
    // `/link` as the code "link" turns an ordinary page load into a failed
    // approval attempt — which is how a spurious "code is not valid" reached
    // a screen where nothing had been scanned.
    expect(parseScannedCode(`https://example.com/link`)).toBeNull();
    expect(parseScannedCode(`https://example.com/`)).toBeNull();
  });

  it(`accepts a bare code`, () => {
    expect(parseScannedCode(`WDJB-MJHT`)).toEqual({ userCode: `WDJB-MJHT` });
  });

  it(`rejects things that cannot be codes`, () => {
    // WHY: a camera sees every QR in the room. Without a shape check, a wifi
    // config or a beer can's URL would be posted to the approval endpoint as a
    // candidate code.
    expect(parseScannedCode(``)).toBeNull();
    expect(parseScannedCode(`   `)).toBeNull();
    expect(parseScannedCode(`WIFI:S:cafe;T:WPA;P:hunter2;;`)).toBeNull();
  });
});
