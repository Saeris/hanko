# hanko

QR-assisted device sign-in for screens without a keyboard — TVs, kiosks, set-top
boxes. An implementation of [RFC 8628][rfc], the OAuth 2.0 Device Authorization
Grant, which is the flow behind Plex, Steam, and Discord's TV sign-in.

The device shows a short code and a QR. The user authorizes on their phone. The
device polls until it hears back, then signs in.

```
┌──────────────────────────────┐
│   Sign in                    │
│                              │
│   Visit example.com/link     │        ▌▌▌ ▌ ▌▌▌
│   and enter this code        │   OR   ▌ ▌▌▌▌ ▌▌
│                              │        ▌▌ ▌ ▌▌▌▌
│      W D J B - M J H T       │        ▌▌▌▌ ▌ ▌▌
└──────────────────────────────┘
```

Zero dependencies beyond [`etiket`][etiket] for QR rendering. Runs anywhere with
WinterTC primitives: Node, browsers, Deno, Bun, Cloudflare Workers.

## Three places this flow lives

hanko ships a baseline for each, and no UI components for any of them — state
and lifecycle hooks instead, so React, Vue, Svelte, Solid, Angular, and React
Native each bind it with their own conventions.

| Entry                         | Runs on                | Gives you                                  |
| ----------------------------- | ---------------------- | ------------------------------------------ |
| `@saeris/hanko` + `/handlers` | your API               | grant lifecycle, `Request`→`Response` glue |
| `@saeris/hanko/client`        | the device signing in  | poll loop, QR rendering                    |
| `@saeris/hanko/approve`       | the device granting it | QR reading, confirmation challenges        |

## Install

```sh
yarn add @saeris/hanko
```

## Server

hanko owns the grant lifecycle and nothing else. It never mints sessions or
tokens: `approve()` records an opaque `subject`, a successful poll hands it
back, and your app issues whatever credential it already knows how to issue.
That is what lets it sit alongside Better-Auth or Supabase rather than competing
with them.

```ts
import { HankoServer } from "@saeris/hanko";
import { MemoryDeviceGrantStore } from "@saeris/hanko/stores/memory";

const hanko = new HankoServer({
  store: new MemoryDeviceGrantStore(),
  verificationUri: `https://example.com/link`
});

// POST /device/authorize — the device starts here
const grant = await hanko.requestAuthorization();
// → { device_code, user_code, verification_uri, verification_uri_complete, ... }

// POST /device/token — the device polls here
const result = await hanko.poll(deviceCode);
if (result.status === `approved`) {
  const session = await createSession(result.subject);
}

// POST /link — the phone approves here, after the user confirms the code
await hanko.approve(userCode, session.userId);
```

### Rendering the screen

```ts
import { renderDeviceQr } from "@saeris/hanko";

const svg = renderDeviceQr(grant.verification_uri_complete, { size: 512 });
```

Defaults are tuned for a TV viewed from across a room. Error correction is `M`,
not `H`: higher correction needs more modules to encode the same URL, so at a
fixed size each module gets smaller — and on a clean screen, module size matters
more than damage tolerance.

**Show the code even when you show the QR.** [RFC 8628 §5.4][rfc-security] asks
the approval page to display the code back so the user can confirm it matches
their screen. That check is the only defense against a phished QR pointing at
someone else's device.

## Device

```ts
import { DeviceAuthClient } from "@saeris/hanko/client";

const client = new DeviceAuthClient({
  tokenUrl: `https://example.com/device/token`,
  deviceCode: grant.device_code,
  interval: grant.interval,
  expiresIn: grant.expires_in,
  hooks: {
    onTransition: (from, to) => render(to),
    onSlowDown: (seconds) => console.log(`slowing to ${seconds}s`)
  }
});

const outcome = await client.run(signal);
// → { status: "authorized", tokens } | "denied" | "expired" | "aborted"
```

Polling only — no SSE or WebSocket. A sign-in screen may stay powered on for
days, and a persistent connection is one more thing to leak and reconnect on
hardware you cannot attach a profiler to.

For the common case where you only want the outcome:

```ts
import { pollUntilAuthorized } from "@saeris/hanko/client";

const outcome = await pollUntilAuthorized({
  tokenUrl,
  deviceCode,
  interval,
  expiresIn
});
```

## Approving device

The phone that is already signed in. Two topologies exist in the wild and hanko
supports both through one flow:

- **Plex**: the OS camera opens `verification_uri_complete` in a browser. The
  code arrives in the query string — no scanning step.
- **Discord / Steam**: the app scans in-place and the user never leaves it.

```ts
import { ApprovalClient, codeEntryChallenge } from "@saeris/hanko/approve";

const client = new ApprovalClient({
  resolve: async (code) =>
    await fetch(`/link?user_code=${code}`).then((r) =>
      r.ok ? r.json() : null
    ),
  submit: async (code, approved) => {
    await fetch(`/link`, {
      method: `POST`,
      body: new URLSearchParams({ user_code: code, approved: String(approved) })
    });
  },
  challenge: codeEntryChallenge(),
  hooks: { onTransition: (from, to) => render(to) }
});

// Plex path — code came from the URL
await client.submitCode(new URL(location.href).searchParams.get(`user_code`));

// Discord/Steam path — scan frames until one carries a code
client.startScanning();
await client.scan(videoElement);

// Then, once the user answers the challenge
await client.confirm(typedCode);
await client.approve();
```

`approve()` refuses until the challenge passes. `deny()` never does — a user who
cannot confirm a code is the one most likely to be looking at a phishing
attempt, and they must always be able to say no.

### Reading QR codes

hanko targets the standard `BarcodeDetector` API rather than a decoder library,
so the native path costs nothing and the fallback is swappable:

```ts
import {
  createBarcodeDetectorScanner,
  hasNativeBarcodeDetector
} from "@saeris/hanko/approve";

// Chrome / Android: native, no install
const scanner = createBarcodeDetectorScanner();

// Everywhere else: the ponyfill (ZXing-C++ via WASM), an OPTIONAL peer dep
import { BarcodeDetector } from "barcode-detector/ponyfill";
const scanner = createBarcodeDetectorScanner({ detector: BarcodeDetector });
```

React Native has no `BarcodeDetector`; `expo-camera` satisfies `QrScanner`
directly:

```ts
const scanner: QrScanner = {
  detect: async (frame) => [{ rawValue: await scanWithExpoCamera(frame) }]
};
```

Scanning is restricted to `qr_code`. A beer can's EAN-13 in the same frame would
otherwise be posted to your approval endpoint as though it were a user code.

### Confirmation challenges

Scanning a QR removes the moment where the user would have noticed the code was
wrong. [RFC 8628 §5.4][rfc-security] asks you to put it back. How much friction
that deserves is a product decision, so it is pluggable:

| Strategy                              | Pattern                    | Friction            |
| ------------------------------------- | -------------------------- | ------------------- |
| `noChallenge()`                       | Discord, Steam             | one tap             |
| `tripletChallenge({ generate })`      | Google mobile approval     | one tap, real check |
| `codeEntryChallenge()`                | GitHub sudo, Plex          | types the code      |
| `platformChallenge({ authenticate })` | FaceID, WebAuthn, passcode | biometric           |

`allOf([...])` composes them. The pairing worth knowing: a biometric proves
possession of the phone, a code check proves the user is looking at the screen
being authorized. Neither covers both.

```ts
import {
  allOf,
  codeEntryChallenge,
  platformChallenge
} from "@saeris/hanko/approve";

const challenge = allOf([
  platformChallenge({
    authenticate: () => LocalAuthentication.authenticateAsync()
  }),
  codeEntryChallenge()
]);
```

For a public screen — a taproom TV anyone can walk up to — do not use
`noChallenge()`.

## Opening the app from a scanned code

One QR should open the native app when it is installed, and the web page when it
is not — without the device ever showing an error.

That rules out custom schemes as the QR payload. A `beerjournal://` code read by
the OS camera on a phone without the app fails silently and unrecoverably: the
user sees "cannot open" with nowhere to go. **Universal Links (iOS) and App
Links (Android)** solve this by making the payload an ordinary `https://` URL
that the OS _routes_ to the app when the domain and app are associated.

So the QR keeps encoding `verification_uri_complete` unchanged. The routing
lives in association files served from the same origin:

```ts
import { createWellKnownHandler } from "@saeris/hanko/handlers";

const wellKnown = createWellKnownHandler({
  appleAppIds: [`QQ57RJ5UTD.gg.saeris.beerjournal`],
  androidPackageName: `gg.saeris.beerjournal`,
  // SHA-256 of the PLAY-signed cert, not your local keystore.
  androidFingerprints: [`AA:BB:...`]
});
```

Both files must be served from the **same origin** as the approval page, over
HTTPS, **with no redirects**. A redirect or a wrong content-type makes the
association fail silently, with nothing in any log — the usual reason universal
links "just don't work".

### Expo

```ts
import { expoLinkingConfig } from "@saeris/hanko";

// Merge into app.json
expoLinkingConfig({ origin: `https://example.com`, scheme: `beerjournal` });
// → { scheme, ios: { associatedDomains: ["applinks:example.com"] },
//     android: { intentFilters: [{ autoVerify: true, ... }] } }
```

Two things that silently break this:

- `associatedDomains` takes **no protocol** — `applinks:example.com`, never
  `applinks:https://example.com`.
- `autoVerify: true` is what makes Android fetch `assetlinks.json` and open the
  app without a chooser dialog. Without it the link is registered and
  practically useless.

**Universal links do not work in Expo Go.** The entitlement is registered at
build time, so this needs a development or production build. A project pinned to
Expo Go uses the web fallback until it moves to dev builds — which is a
sequencing constraint, not a blocker: the same QR already works.

Receiving the link:

```ts
import * as Linking from "expo-linking";
import { parseApprovalLink } from "@saeris/hanko/approve";

const initial = await Linking.getInitialURL();
const link = initial && parseApprovalLink(initial, { scheme: `beerjournal` });
if (link) await client.submitCode(link.userCode);
```

### PWAs on both ends

The whole flow works PWA-to-PWA, with one caveat worth knowing up front.

**The signing-in device** (the TV) is the easy half: it renders a code and an
SVG QR, then polls. No camera, no install, no platform APIs. A Fire Stick or Pi
browser runs it as-is.

**The approving device** is where PWAs get thin:

| Capability                          | Status                                |
| ----------------------------------- | ------------------------------------- |
| Receive an https link               | works everywhere                      |
| `launch_handler: navigate-existing` | Chromium only; falls back cleanly     |
| Camera scanning (`getUserMedia`)    | works, but see below                  |
| Being the OS camera's target        | **installed PWAs cannot claim links** |

The last row is the real constraint: a PWA cannot register for Universal Links.
The OS camera opens the _browser_, not your installed PWA. `launch_handler` only
controls what happens once the link reaches your origin.

Camera access inside an installed iOS PWA was broken from iOS 18 until 18.4, and
permission still is not persisted the way it is in Safari proper. So on the
approving side, **the typed-code path is the reliability floor, not a nicety** —
build the scanner as an enhancement over it, never the only way in.

```ts
import { consumeLaunchTarget, parseApprovalLink } from "@saeris/hanko/approve";

// Reads launchQueue where supported, falls back to location.href elsewhere
consumeLaunchTarget((href) => {
  const link = parseApprovalLink(href);
  if (link) void client.submitCode(link.userCode);
});
```

Add `pwaLaunchHandler()` to your manifest so a scanned link reuses the open
window rather than stacking a second one behind it.

### What each device actually gets

| Approving device                      | Scanned QR opens            | Notes                     |
| ------------------------------------- | --------------------------- | ------------------------- |
| Native app installed (dev/prod build) | the app, directly           | best case                 |
| Native app absent                     | the web page                | same QR, no error         |
| Installed PWA                         | the browser, then your page | PWA cannot claim the link |
| Desktop browser                       | the web page                | typed code only           |

Every row reaches a working approval screen. That is the property worth
protecting — and the reason the payload stays an `https://` URL.

## Edge runtimes

The server half is stateless by construction: every request loads its grant,
applies one transition, and writes it back. Nothing is held between
invocations, so a flow survives its requests landing on different workers, or
on an instance frozen mid-flow.

```ts
// Cloudflare Workers
import { createHandlers } from "@saeris/hanko/handlers";
import { HankoServer } from "@saeris/hanko";
import { KvDeviceGrantStore, kvFromOptionsApi } from "@saeris/hanko/stores/kv";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handlers = createHandlers({
      server: new HankoServer({
        store: new KvDeviceGrantStore({
          kv: kvFromOptionsApi({
            get: (k) => env.GRANTS.get(k),
            set: (k, v, o) => env.GRANTS.put(k, v, o),
            remove: (k) => env.GRANTS.delete(k)
          })
        }),
        verificationUri: `https://example.com/link`
      }),
      // Read from YOUR session — never from the request body.
      authenticate: (req) => getSession(req)?.userId ?? null,
      createSession: (subject) => mintToken(subject),
      rateLimit: (req, code) =>
        limiter.check(req.headers.get(`CF-Connecting-IP`), code)
    });
    return handlers.fetch(request);
  }
};
```

The individual handlers — `authorize`, `token`, `approval` — are exported
separately for file-based routing (Astro, Next, SvelteKit, Vercel Functions).

### Multiple hostnames, one deployment

The QR has to encode the host the device is actually talking to. One deployment
is commonly reachable through several — a preview URL, a custom domain, a
tunnel during development — and a `verificationUri` fixed at construction time
points at only one of them. The failure is silent: the code renders correctly
and the phone lands nowhere.

`createAuthorizationHandler` therefore derives the origin per request from
`x-forwarded-host` and `x-forwarded-proto`, which every common proxy sets —
ngrok, Cloudflare, Vercel, nginx. The configured `verificationUri` remains the
fallback for direct requests that carry no forwarded headers.

```ts
createAuthorizationHandler({
  server,
  verificationPath: `/link`, // appended to the detected origin
  trustForwardedHost: true // the default
});
```

Set `trustForwardedHost: false` to always use the configured value. Worth doing
if your platform does not strip client-sent `x-forwarded-*` headers and you
would rather pin the origin: those headers are client-controllable in that
case. They are safe for building a URL the same client will visit — which is
all this does — but never use them for an authorization decision.

Calling the server directly takes the same override:

```ts
await server.requestAuthorization({
  verificationUri: `https://${request.headers.get("x-forwarded-host")}/link`
});
```

### Persistence

| Layer                               | Adapter                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| Upstash Redis, Vercel KV, `ioredis` | `KvDeviceGrantStore` + `kvFromOptionsApi({ ttlKey: "ex" })` |
| Cloudflare Workers KV               | `kvFromOptionsApi({ ttlKey: "expirationTtl" })`             |
| Deno KV                             | `KeyValueAdapter` directly                                  |
| Supabase / Postgres                 | implement `DeviceGrantStore` (four methods)                 |
| Durable Objects                     | implement `DeviceGrantStore` over `ctx.storage`             |

TTL does the pruning, with a grace window past the deadline so the server can
answer `expired_token` honestly instead of "unknown code" — which a client
cannot distinguish from a typo.

**Rate limiting is your job.** [§5.1][rfc-security] requires it, and hanko
cannot do it portably: an effective limiter needs the client IP, which lives in
a platform-specific header. The `rateLimit` seam exists so the requirement is
not silently skipped.

## State machines

Both halves are explicit state machines with declarative transition tables. The
transitions are data, so they can be read against the RFC side by side — and
illegal moves are impossible by construction rather than guarded against.

**Grant** (server):

```
pending ──APPROVE──▶ approved ──REDEEM──▶ consumed
   │                     │
   ├──DENY────▶ denied   └──EXPIRE──▶ expired
   └──EXPIRE──▶ expired
```

Redemption, not approval, is what ends the flow — a `device_code` that stayed
redeemable after approval would be a replayable bearer credential. And an
approval nobody collected still expires.

**Poll** (device):

```
idle ──START──▶ waiting ──TICK──▶ polling
                   ▲                 │
                   └── pending ──────┤── SUCCESS ────────▶ authorized
                       slow_down     ├── ACCESS_DENIED ──▶ denied
                       network error └── EXPIRED_TOKEN ──▶ expired
```

The interval lives in context, not state: `waiting` at 5s and `waiting` at 20s
are the same state. That separation keeps the two pacing rules distinct —
`slow_down` adds a fixed 5s permanently ([§3.5][rfc-token]), while a network
failure doubles with a cap. Conflating them either hammers a struggling server
or crawls when it only asked for a small delay.

**Approval** (the phone):

```
idle ──SCAN──▶ scanning ──CODE──▶ resolving ──RESOLVED──▶ confirming
  │                                    │                      │
  └──CODE (from URL)───────────────────┘                      │
                                       └──REJECTED──▶ invalid │
                                                              ▼
                          approved ◀──SUBMITTED── submitting ─┘
                          denied   ◀──SUBMITTED──
```

`confirming` accepts `CHALLENGE_FAILED` back into itself: a mistyped code is a
retry, not a dead end. Both entry paths — scanned in-app or arriving by URL —
converge on the same confirmation, so the security-sensitive half is written
once.

All three machines are exported if you want to drive them yourself — persisting
grant state in a Durable Object, say, or rendering a screen straight from the
state:

```ts
import {
  grantTransition,
  pollTransition,
  approvalTransition,
  canTransitionGrant
} from "@saeris/hanko";
```

## Codes

Defaults follow the spec's worked example: 8 characters from a 20-consonant
alphabet, displayed as `WDJB-MJHT`. No vowels, so codes cannot spell words; no
digits, so there is no `0`/`O` or `1`/`l`/`I` confusion.

```ts
import { generateUserCode, NUMERIC_ALPHABET } from "@saeris/hanko";

generateUserCode(); // "WDJB-MJHT"
generateUserCode({ alphabet: NUMERIC_ALPHABET, length: 9 }); // "0194-5073-0"
```

A short code is a small keyspace, which is the deliberate trade for
readability. **[RFC 8628 §5.1][rfc-security] requires you to rate-limit
attempts** — the code alone is not brute-force resistant, and hanko does not
rate-limit for you. That belongs at your HTTP boundary, where you can see IPs.

## Storage

`DeviceGrantStore` is four methods, so adapters are small:

```ts
interface DeviceGrantStore {
  create(grant: DeviceGrant): Promise<void> | void;
  findByDeviceCode(
    deviceCode: string
  ): Promise<DeviceGrant | null> | DeviceGrant | null;
  findByUserCode(
    userCode: string
  ): Promise<DeviceGrant | null> | DeviceGrant | null;
  update(grant: DeviceGrant): Promise<void> | void;
  prune?(now: number): Promise<void> | void;
}
```

The bundled `MemoryDeviceGrantStore` is for development only — state dies with
the process and is not shared across instances.

## License

MIT © [Drake Costa](https://saeris.gg)

[rfc]: https://datatracker.ietf.org/doc/html/rfc8628
[rfc-token]: https://datatracker.ietf.org/doc/html/rfc8628#section-3.5
[rfc-security]: https://datatracker.ietf.org/doc/html/rfc8628#section-5
[etiket]: https://github.com/productdevbook/etiket
