import { describe, expect, it, vi } from "vitest";
import { createHandlers } from "../handlers.js";
import { HankoServer } from "../server.js";
import { KvDeviceGrantStore } from "../stores/kv.js";
import type { KeyValueAdapter } from "../stores/kv.js";

/** In-memory KV standing in for Upstash / Workers KV / Deno KV. */
const fakeKv = (): KeyValueAdapter & { store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => Promise.resolve(store.get(key) ?? null),
    set: async (key, value) => {
      store.set(key, value);
      await Promise.resolve();
    },
    delete: async (key) => {
      store.delete(key);
      await Promise.resolve();
    }
  };
};

const setup = ({
  subject = `did:plc:example`,
  rateLimit
}: { subject?: string | null; rateLimit?: () => boolean } = {}) => {
  const kv = fakeKv();
  const server = new HankoServer({
    store: new KvDeviceGrantStore({ kv }),
    verificationUri: `https://example.com/link`
  });
  const createSession = vi.fn<(subject: string) => unknown>((s) => ({
    access_token: `tok-${s}`
  }));
  const handlers = createHandlers({
    server,
    authenticate: () => subject,
    createSession,
    rateLimit
  });
  return { handlers, kv, createSession };
};

const post = (url: string, body: Record<string, string>): Request =>
  new Request(url, {
    method: `POST`,
    headers: { "content-type": `application/x-www-form-urlencoded` },
    body: new URLSearchParams(body)
  });

describe(`edge handlers`, () => {
  it(`carries a whole flow across separate requests`, async () => {
    // WHY: the point of the edge story. Nothing is held in the instance
    // between calls, so each request rehydrates from the store — which is what
    // lets these run on a worker that may be frozen or replaced mid-flow.
    const { handlers, createSession } = setup();

    const authorized = await handlers.authorize(
      post(`https://api.test/device/authorize`, { client_id: `taproom-tv` })
    );
    const grant = (await authorized.json()) as {
      device_code: string;
      user_code: string;
    };

    const pending = await handlers.token(
      post(`https://api.test/device/token`, { device_code: grant.device_code })
    );
    expect(pending.status).toBe(400);
    await expect(pending.json()).resolves.toEqual({
      error: `authorization_pending`
    });

    const approved = await handlers.approval(
      post(`https://api.test/link`, {
        user_code: grant.user_code,
        approved: `true`
      })
    );
    expect(approved.status).toBe(200);

    const redeemed = await handlers.token(
      post(`https://api.test/device/token`, { device_code: grant.device_code })
    );
    await expect(redeemed.json()).resolves.toEqual({
      access_token: `tok-did:plc:example`
    });
    expect(createSession).toHaveBeenCalledWith(`did:plc:example`);
  });

  it(`returns RFC status codes, not 200s`, async () => {
    // WHY: a compliant client reads `error` from a 400 body. Answering 200 for
    // `authorization_pending` would make hanko's server incompatible with any
    // client it did not ship itself.
    const { handlers } = setup();
    const response = await handlers.token(
      post(`https://api.test/device/token`, { device_code: `nope` })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: `expired_token` });
  });

  it(`never lets the device code leave the server`, async () => {
    // WHY: `device_code` is the bearer credential. If the approval endpoint
    // echoed it, anyone who could resolve a user code could redeem the grant
    // themselves.
    const { handlers } = setup();
    const authorized = await handlers.authorize(
      post(`https://api.test/device/authorize`, {})
    );
    const grant = (await authorized.json()) as { user_code: string };

    const lookup = await handlers.approval(
      new Request(
        `https://api.test/link?user_code=${encodeURIComponent(grant.user_code)}`
      )
    );
    const body = (await lookup.json()) as Record<string, unknown>;

    // Normalized, not the display form: the store keeps codes separator-free so
    // lookup never depends on formatting. Comparison against what the TV shows
    // is normalized on both sides — see `codeEntryChallenge`.
    expect(body.user_code).toBe(grant.user_code.replace(`-`, ``));
    expect(body).not.toHaveProperty(`device_code`);
  });

  it(`refuses approval from an unauthenticated caller`, async () => {
    // WHY: the trust boundary. The approving device's session is what the TV
    // inherits — an anonymous caller must not be able to grant anything.
    const { handlers } = setup({ subject: null });
    const response = await handlers.approval(
      post(`https://api.test/link`, {
        user_code: `WDJB-MJHT`,
        approved: `true`
      })
    );
    expect(response.status).toBe(401);
  });

  it(`denies when the approval flag is absent`, async () => {
    // WHY: fail closed. A malformed or truncated body must never be read as
    // consent.
    const { handlers } = setup();
    const authorized = await handlers.authorize(
      post(`https://api.test/device/authorize`, {})
    );
    const grant = (await authorized.json()) as {
      device_code: string;
      user_code: string;
    };

    await handlers.approval(
      post(`https://api.test/link`, { user_code: grant.user_code })
    );

    const polled = await handlers.token(
      post(`https://api.test/device/token`, { device_code: grant.device_code })
    );
    await expect(polled.json()).resolves.toEqual({ error: `access_denied` });
  });

  it(`honors a rate limiter on the approval endpoint`, async () => {
    // WHY: RFC 8628 §5.1 REQUIRES rate limiting — the user code is short by
    // design and not brute-force resistant on its own. hanko cannot implement
    // it portably, so the seam must at least be wired.
    const { handlers } = setup({ rateLimit: () => false });
    const response = await handlers.approval(
      new Request(`https://api.test/link?user_code=WDJB-MJHT`)
    );
    expect(response.status).toBe(429);
  });

  it(`marks responses no-store`, async () => {
    // WHY: a cached `authorization_pending` served to a later poll would stall
    // the device until its code expired, with no error to explain why.
    const { handlers } = setup();
    const response = await handlers.authorize(
      post(`https://api.test/device/authorize`, {})
    );
    expect(response.headers.get(`cache-control`)).toBe(`no-store`);
  });

  it(`accepts JSON as well as form encoding`, async () => {
    // WHY: the spec says form-encoded, but hosts post JSON from their own front
    // end constantly. Rejecting it would be pedantry, not security.
    const { handlers } = setup();
    const response = await handlers.authorize(
      new Request(`https://api.test/device/authorize`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ client_id: `taproom-tv` })
      })
    );
    expect(response.status).toBe(200);
  });

  it(`routes by path for single-entry runtimes`, async () => {
    // WHY: a Workers `fetch` is one function. Without a router, every host
    // rewrites the same three-way path match.
    const { handlers } = setup();
    expect(
      (await handlers.fetch(post(`https://api.test/device/authorize`, {})))
        .status
    ).toBe(200);
    expect(
      (await handlers.fetch(new Request(`https://api.test/nope`))).status
    ).toBe(404);
  });
});

describe(`kvDeviceGrantStore`, () => {
  it(`points the user code at the record rather than copying it`, async () => {
    // WHY: the record changes on every poll. Two copies would diverge, and the
    // approval page would show an interval the device had already outgrown.
    const kv = fakeKv();
    const store = new KvDeviceGrantStore({ kv });
    const server = new HankoServer({
      store,
      verificationUri: `https://e.test/l`
    });

    const grant = await server.requestAuthorization();
    await server.poll(grant.device_code);

    const byUser = await store.findByUserCode(grant.user_code.replace(`-`, ``));
    const byDevice = await store.findByDeviceCode(grant.device_code);
    expect(byUser).toEqual(byDevice);
  });

  it(`survives a corrupt stored value`, async () => {
    // WHY: a shared store may hold a record written by an older deploy. An
    // edge function must answer `expired_token`, not throw a 500.
    const kv = fakeKv();
    const store = new KvDeviceGrantStore({ kv });
    kv.store.set(`hanko:device:broken`, `{not json`);
    kv.store.set(`hanko:device:partial`, `{"device_code":"x"}`);

    await expect(store.findByDeviceCode(`broken`)).resolves.toBeNull();
    await expect(store.findByDeviceCode(`partial`)).resolves.toBeNull();
  });

  it(`keeps keys alive past the deadline so expiry can be reported`, async () => {
    // WHY: without the grace window a grant vanishes exactly when it expires,
    // and the device's next poll gets "unknown code" — indistinguishable from a
    // typo, so the client retries instead of stopping.
    const kv = fakeKv();
    const ttls: number[] = [];
    const recording: KeyValueAdapter = {
      ...kv,
      set: async (key, value, ttl) => {
        ttls.push(ttl);
        await kv.set(key, value, ttl);
      }
    };
    const store = new KvDeviceGrantStore({
      kv: recording,
      graceSeconds: 60,
      now: () => 0
    });

    await store.create({
      device_code: `d`,
      user_code: `U`,
      status: `pending`,
      expiresAt: 900_000,
      interval: 5
    });

    expect(ttls[0]).toBe(960);
  });
});
