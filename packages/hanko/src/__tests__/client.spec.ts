import { describe, expect, it, vi } from "vitest";
import { pollUntilAuthorized, sleep } from "../client/index.js";
import { DEVICE_CODE_GRANT_TYPE } from "../types.js";

/** Queue of canned token-endpoint responses. */
const stubFetch = (
  responses: object[]
): { impl: typeof fetch; calls: { body: URLSearchParams }[] } => {
  const calls: { body: URLSearchParams }[] = [];
  let index = 0;
  const impl = vi.fn<typeof fetch>(async (_url, init) => {
    calls.push({ body: init?.body as URLSearchParams });
    const payload = responses[Math.min(index++, responses.length - 1)];
    return {
      ok: true,
      json: async (): Promise<object | undefined> => payload
    } as Response;
  });
  return { impl, calls };
};

/**
 * Instant sleep that records what the loop *would* have waited.
 *
 * Lets the growing intervals be asserted directly instead of inferred from
 * callbacks — and keeps the suite from actually waiting them out.
 */
const recordingSleep = () => {
  const delays: number[] = [];
  const impl = async (ms: number, signal?: AbortSignal) => {
    delays.push(ms);
    if (signal?.aborted) return;
    await Promise.resolve();
  };
  return { impl, delays };
};

/**
 * A realistic 5s interval, but the wait is stubbed out by default so the suite
 * runs instantly. Tests that assert cadence override `sleepImpl` with a
 * recording sleeper; the abort test overrides it back to the real one.
 */
const base = {
  tokenUrl: `https://example.com/token`,
  deviceCode: `dev-code`,
  interval: 5,
  expiresIn: 900,
  sleepImpl: async () => {
    await Promise.resolve();
  }
};

describe(`pollUntilAuthorized`, () => {
  it(`keeps polling through pending and resolves with the host's payload`, async () => {
    // WHY: the pass-through is deliberate — hanko does not mint sessions, it
    // carries whatever credential the host app returns. Parsing or reshaping
    // it here would couple the library to one auth provider.
    const { impl } = stubFetch([
      { error: `authorization_pending` },
      { error: `authorization_pending` },
      { access_token: `tok`, token_type: `Bearer` }
    ]);

    const outcome = await pollUntilAuthorized({ ...base, fetchImpl: impl });

    expect(outcome).toEqual({
      status: `authorized`,
      tokens: { access_token: `tok`, token_type: `Bearer` }
    });
  });

  it(`sends the spec's grant type`, async () => {
    // WHY: a compliant OAuth server rejects anything else, and the failure is
    // an opaque invalid_request rather than a useful message.
    const { impl, calls } = stubFetch([{ access_token: `tok` }]);
    await pollUntilAuthorized({
      ...base,
      clientId: `taproom-tv`,
      fetchImpl: impl
    });

    expect(calls[0].body.get(`grant_type`)).toBe(DEVICE_CODE_GRANT_TYPE);
    expect(calls[0].body.get(`device_code`)).toBe(`dev-code`);
    expect(calls[0].body.get(`client_id`)).toBe(`taproom-tv`);
  });

  it(`adds 5 seconds per slow_down and never resets`, async () => {
    // WHY: mirrors the server's rule. If the client reset its interval after a
    // successful poll it would immediately earn another slow_down, ratcheting
    // the cadence up until the code expires.
    const onSlowDown = vi.fn<(interval: number) => void>();
    const sleeper = recordingSleep();
    const { impl } = stubFetch([
      { error: `slow_down` },
      { error: `slow_down` },
      { access_token: `tok` }
    ]);

    await pollUntilAuthorized({
      ...base,
      fetchImpl: impl,
      sleepImpl: sleeper.impl,
      onSlowDown
    });

    expect(onSlowDown.mock.calls.map(([interval]) => interval)).toEqual([
      10, 15
    ]);
    // The waits themselves must grow, not just the reported number.
    expect(sleeper.delays).toEqual([5000, 10_000, 15_000]);
  });

  it(`stops on denial`, async () => {
    const { impl, calls } = stubFetch([{ error: `access_denied` }]);
    await expect(
      pollUntilAuthorized({ ...base, fetchImpl: impl })
    ).resolves.toEqual({
      status: `denied`
    });
    expect(calls).toHaveLength(1);
  });

  it(`stops on server-reported expiry`, async () => {
    const { impl } = stubFetch([{ error: `expired_token` }]);
    await expect(
      pollUntilAuthorized({ ...base, fetchImpl: impl })
    ).resolves.toEqual({
      status: `expired`
    });
  });

  it(`gives up at its own deadline even if the server never says so`, async () => {
    // WHY: a screen left polling a dead code forever is both a support call and
    // needless load. The client owns its deadline independently.
    const { impl } = stubFetch([{ error: `authorization_pending` }]);
    const sleeper = recordingSleep();
    let current = 0;

    const outcome = await pollUntilAuthorized({
      ...base,
      expiresIn: 10,
      fetchImpl: impl,
      sleepImpl: sleeper.impl,
      now: () => {
        current += 20_000;
        return current;
      }
    });

    expect(outcome).toEqual({ status: `expired` });
  });

  it(`backs off exponentially on network failure without ending the flow`, async () => {
    // WHY: venue wifi drops. A blip must not look like denial — the user has
    // done nothing wrong and the code is still valid. Note this is exponential,
    // unlike slow_down's fixed +5s: congestion, not server policy.
    const onSlowDown = vi.fn<(interval: number) => void>();
    const sleeper = recordingSleep();
    let call = 0;
    const impl = vi.fn<typeof fetch>(async () => {
      call += 1;
      if (call <= 2) throw new Error(`network down`);
      return {
        ok: true,
        json: async (): Promise<object> => ({ access_token: `tok` })
      } as Response;
    });

    const outcome = await pollUntilAuthorized({
      ...base,
      interval: 1,
      fetchImpl: impl,
      sleepImpl: sleeper.impl,
      onSlowDown
    });

    expect(outcome).toMatchObject({ status: `authorized` });
    // Doubling, not +5s — this is congestion, not server policy.
    expect(sleeper.delays).toEqual([1000, 2000, 4000]);
    // Recovery is silent: a transient blip is not a cadence change the UI
    // should announce.
    expect(onSlowDown).not.toHaveBeenCalled();
  });

  it(`aborts promptly when the screen is dismissed`, async () => {
    // WHY: without wiring abort into the sleep, the loop finishes a full
    // interval before noticing — on a 15s cadence that is a visibly stuck UI.
    const controller = new AbortController();
    const { impl } = stubFetch([{ error: `authorization_pending` }]);

    // Deliberately uses a REAL timer that honors the signal — the same shape as
    // the library's own sleep. An instant stub would bypass the very behavior
    // under test.
    const pending = pollUntilAuthorized({
      ...base,
      interval: 30,
      fetchImpl: impl,
      signal: controller.signal,
      // The library's own sleep — the behavior under test is that IT honors
      // the signal, so substituting a stub would prove nothing.
      sleepImpl: sleep
    });
    controller.abort();

    // Resolves immediately rather than after 30s — that IS the assertion.
    await expect(pending).resolves.toEqual({ status: `aborted` });
  }, 1000);
});
