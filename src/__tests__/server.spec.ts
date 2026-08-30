import { beforeEach, describe, expect, it } from "vitest";
import { createHankoServer } from "../server.js";
import { MemoryDeviceGrantStore } from "../stores/memory.js";
import { normalizeUserCode } from "../codes.js";

/** Controllable clock so expiry and interval logic are deterministic. */
const createClock = (start = 1_700_000_000_000) => {
  let current = start;
  return {
    now: () => current,
    advanceSeconds: (seconds: number) => {
      current += seconds * 1000;
    }
  };
};

const setup = (
  options: Partial<Parameters<typeof createHankoServer>[0]> = {}
) => {
  const clock = createClock();
  const store = new MemoryDeviceGrantStore();
  const server = createHankoServer({
    store,
    verificationUri: `https://example.com/link`,
    now: clock.now,
    ...options
  });
  return { clock, store, server };
};

describe(`requestAuthorization`, () => {
  it(`returns every field the device needs to render the sign-in screen`, async () => {
    // WHY: the TV screen shows the code, the URL, and a QR built from
    // verification_uri_complete. A missing field means a blank region on a
    // screen nobody can interact with to recover.
    const { server } = setup();
    const res = await server.requestAuthorization();

    // Non-empty rather than merely present: an empty string would render a
    // blank code on the TV and still satisfy a truthiness check on the key.
    expect(res.device_code.length).toBeGreaterThan(0);
    expect(res.user_code.length).toBeGreaterThan(0);
    expect(res.verification_uri).toBe(`https://example.com/link`);
    expect(res.verification_uri_complete).toContain(`user_code=`);
    expect(res.expires_in).toBe(900);
    expect(res.interval).toBe(5);
  });

  it(`embeds the displayed code in the QR target`, async () => {
    // WHY: scanning the QR must land the user on a page already scoped to THIS
    // device. If the embedded code drifted from the displayed one, the user
    // would be asked to approve a code that does not match their screen — the
    // exact condition §5.4's confirmation step exists to catch.
    const { server } = setup();
    const res = await server.requestAuthorization();
    const embedded = new URL(res.verification_uri_complete!).searchParams.get(
      `user_code`
    );
    expect(embedded).toBe(res.user_code);
  });

  it(`stores the code normalized so lookup is display-format agnostic`, async () => {
    // WHY: the wire shows `WDJB-MJHT`; a user may type `wdjb mjht`. Storing the
    // normalized form means the separator can change later without orphaning
    // in-flight grants.
    const { server, store } = setup();
    const res = await server.requestAuthorization();
    expect(
      store.findByUserCode(normalizeUserCode(res.user_code))
    ).not.toBeNull();
  });

  it(`honors a custom QR URL builder`, async () => {
    const { server } = setup({
      buildVerificationUriComplete: (code, uri) => `${uri}/${code}`
    });
    const res = await server.requestAuthorization();
    expect(res.verification_uri_complete).toBe(
      `https://example.com/link/${res.user_code}`
    );
  });
});

describe(`poll`, () => {
  it(`reports pending until someone approves`, async () => {
    const { server, clock } = setup();
    const res = await server.requestAuthorization();

    const first = await server.poll(res.device_code);
    expect(first).toEqual({
      status: `pending`,
      error: `authorization_pending`
    });

    clock.advanceSeconds(5);
    const second = await server.poll(res.device_code);
    expect(second.status).toBe(`pending`);
  });

  it(`returns the subject once approved, so the host can mint a session`, async () => {
    // WHY: this hand-off IS the library's purpose — carrying an opaque identity
    // from the phone that authenticated to the TV that could not.
    const { server } = setup();
    const res = await server.requestAuthorization();
    await server.approve(res.user_code, `did:plc:example`);

    await expect(server.poll(res.device_code)).resolves.toEqual({
      status: `approved`,
      subject: `did:plc:example`
    });
  });

  it(`refuses to hand out the subject twice`, async () => {
    // WHY: a device_code is a bearer credential. If a replayed poll kept
    // returning the subject, anyone who captured it could mint sessions
    // indefinitely. Redemption — not approval — must be terminal.
    const { server } = setup();
    const res = await server.requestAuthorization();
    await server.approve(res.user_code, `did:plc:example`);

    expect((await server.poll(res.device_code)).status).toBe(`approved`);
    await expect(server.poll(res.device_code)).resolves.toEqual({
      status: `expired`,
      error: `expired_token`
    });
  });

  it(`raises the interval by exactly 5 seconds when polled too fast`, async () => {
    // WHY: RFC 8628 §3.5 mandates "increased by 5 seconds for this and all
    // subsequent requests" — additive and sticky, NOT exponential backoff
    // (which the spec reserves for connection timeouts). Getting this wrong
    // makes a compliant client and this server disagree about cadence.
    const { server, clock } = setup();
    const res = await server.requestAuthorization();

    await server.poll(res.device_code);
    clock.advanceSeconds(1);

    const tooFast = await server.poll(res.device_code);
    expect(tooFast).toEqual({
      status: `slow_down`,
      error: `slow_down`,
      interval: 10
    });

    clock.advanceSeconds(1);
    const stillTooFast = await server.poll(res.device_code);
    expect(stillTooFast).toMatchObject({ status: `slow_down`, interval: 15 });
  });

  it(`does not penalize a client that waits its turn`, async () => {
    const { server, clock } = setup();
    const res = await server.requestAuthorization();
    await server.poll(res.device_code);

    clock.advanceSeconds(5);
    expect((await server.poll(res.device_code)).status).toBe(`pending`);
  });

  it(`expires on read rather than relying on a sweeper`, async () => {
    // WHY: serverless instances die and TVs outlive any timer we set. If expiry
    // were only enforced by a background job, a grant could be observed as
    // pending — and approved — long past its deadline, defeating the short
    // lifetime that limits phishing value.
    const { server, clock } = setup();
    const res = await server.requestAuthorization();

    clock.advanceSeconds(901);
    await expect(server.poll(res.device_code)).resolves.toEqual({
      status: `expired`,
      error: `expired_token`
    });
  });

  it(`reports denial so the device stops polling`, async () => {
    const { server } = setup();
    const res = await server.requestAuthorization();
    await server.deny(res.user_code);

    await expect(server.poll(res.device_code)).resolves.toEqual({
      status: `denied`,
      error: `access_denied`
    });
  });

  it(`does not reveal whether an unknown device code ever existed`, async () => {
    // WHY: answering "not found" differently from "expired" would let an
    // attacker probe which device codes are live. Both collapse to
    // expired_token.
    const { server } = setup();
    await expect(server.poll(`totally-made-up`)).resolves.toEqual({
      status: `expired`,
      error: `expired_token`
    });
  });
});

describe(`approve / deny`, () => {
  it(`accepts the code as the user actually typed it`, async () => {
    // WHY: the approving device is a phone. Users paste with stray whitespace,
    // keyboards lowercase, and the dash may or may not survive. All of these
    // must resolve to the same grant or the flow dead-ends with no explanation.
    const { server } = setup();
    const res = await server.requestAuthorization();
    const messy = ` ${res.user_code.toLowerCase().replace(`-`, ` `)} `;

    await expect(
      server.approve(messy, `did:plc:example`)
    ).resolves.toMatchObject({
      ok: true
    });
  });

  it(`exposes the grant for the confirmation screen`, async () => {
    // WHY: §5.4 requires the approval page to show the code back so the user
    // confirms it matches their TV. That check is the only defense against a
    // phished QR pointing at an attacker's device, so lookup must work before
    // approval, not just during it.
    const { server } = setup();
    const res = await server.requestAuthorization();

    const grant = await server.lookupByUserCode(res.user_code);
    expect(grant?.user_code).toBe(normalizeUserCode(res.user_code));
    expect(grant?.status).toBe(`pending`);
  });

  it(`refuses an unknown code`, async () => {
    const { server } = setup();
    await expect(
      server.approve(`ZZZZ-ZZZZ`, `did:plc:x`)
    ).resolves.toMatchObject({
      ok: false,
      reason: `not_found`
    });
  });

  it(`refuses to approve an expired grant`, async () => {
    // WHY: short lifetimes are the mitigation for a phished code. Approving
    // past the deadline would restore exactly the value an attacker wants.
    const { server, clock } = setup();
    const res = await server.requestAuthorization();
    clock.advanceSeconds(901);

    await expect(
      server.approve(res.user_code, `did:plc:x`)
    ).resolves.toMatchObject({
      ok: false,
      reason: `expired`
    });
  });

  it(`refuses to re-decide a resolved grant`, async () => {
    // WHY: without this, a denied grant could be flipped to approved by a
    // second request — a trivial way to override the user's refusal.
    const { server } = setup();
    const res = await server.requestAuthorization();
    await server.deny(res.user_code);

    await expect(
      server.approve(res.user_code, `did:plc:x`)
    ).resolves.toMatchObject({
      ok: false,
      reason: `already_resolved`
    });
  });

  it(`keeps concurrent flows independent`, async () => {
    // WHY: a taproom may bring several screens online at once. Approving one
    // must not authorize the others.
    const { server } = setup();
    const a = await server.requestAuthorization();
    const b = await server.requestAuthorization();

    await server.approve(a.user_code, `did:plc:a`);

    await expect(server.poll(a.device_code)).resolves.toMatchObject({
      subject: `did:plc:a`
    });
    expect((await server.poll(b.device_code)).status).toBe(`pending`);
  });
});

describe(`memoryDeviceGrantStore`, () => {
  let store: MemoryDeviceGrantStore;

  beforeEach(() => {
    store = new MemoryDeviceGrantStore();
  });

  it(`prunes both indexes together`, async () => {
    // WHY: clearing only the primary map leaks user_code entries pointing at
    // deleted grants — an unbounded leak on a long-lived dev server, and a
    // source of phantom lookups.
    const clock = createClock();
    const server = createHankoServer({
      store,
      verificationUri: `https://example.com/link`,
      now: clock.now
    });
    const res = await server.requestAuthorization();

    expect(store.size).toBe(1);
    clock.advanceSeconds(901);
    store.prune(clock.now());

    expect(store.size).toBe(0);
    expect(store.findByUserCode(normalizeUserCode(res.user_code))).toBeNull();
  });
});
