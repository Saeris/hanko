# hanko Astro demo

The whole flow across three devices: a screen that cannot be typed into, a
phone that approves it, and an API in between.

## Just on this machine

```sh
yarn demo
```

Open <http://localhost:4321>. Two browser windows are enough to walk the flow —
one on `/tv`, one on `/link` — and the typed-code path works fully.

That builds the library first. The example imports `@saeris/hanko` by package
name and resolves through its `exports` map, so it exercises the published
surface rather than reaching into source.

## With a real phone

The phone needs **HTTPS**, not just network access. Two hard reasons:

- `getUserMedia` — the camera, for scanning — requires a secure context.
  `localhost` is exempt; `http://192.168.x.x` is **not**, so the camera never
  opens and the failure is silent.
- Universal links and PWA install both require HTTPS.

### Option A — ngrok (recommended on Windows)

A publicly-trusted certificate, so **nothing needs installing on the phone**.

[Portless][portless] is a dev dependency of this example, so `yarn install`
covers it — no global install. You do need the ngrok binary and a free account:

```sh
# once, if you do not already have it
choco install ngrok        # or: brew install ngrok
ngrok config add-authtoken <token>
```

Then one command:

```sh
yarn demo:share
```

It prints a QR of the tunnel URL, the way `expo start` does — scan it and the
phone opens the demo. The URL is discovered from ngrok's local API, so nothing
has to be copied or configured. Free ngrok assigns a new URL on every restart;
that no longer matters either.

**Open `/tv` on the same tunnel URL, not on `localhost`.** Both devices have to
come through the same origin: a grant created on `localhost` produces a QR the
phone cannot reach, and a code the phone's requests will never find. Opening
`/tv` on a local URL now says so instead of rendering a code that cannot
work.

Two things worth knowing: the tunnel is public while it runs, and free ngrok
interstitials a browser warning page on first visit. Tap through it once on the
phone.

**If it says authentication is not configured**, check for orphaned agents
before touching your token. Free ngrok allows three simultaneous sessions, and
a Ctrl+C that does not fully clean up leaves one holding a slot. The fourth
attempt fails with `ERR_NGROK_108`, which Portless surfaces as an
authentication error rather than a session-limit one:

```sh
# Windows
powershell -Command "Get-Process ngrok | Stop-Process -Force"

# macOS / Linux
pkill ngrok
```

### Option B — Portless LAN mode (macOS and Linux only)

Run from `examples/astro`, so the local `portless` binary is on the path:

```sh
yarn portless proxy start --lan
yarn portless run --name hanko astro dev
```

Serves at `https://hanko.local`, reachable from any device on the WiFi. The QR
picks that host up on its own — no environment variable.

**This does not work on Windows.** LAN mode publishes over mDNS, and Portless
implements publishing only via `dns-sd` (macOS) and `avahi-publish-address`
(Linux). Having Bonjour installed does not help — the Windows build has no
publisher and refuses to start:

```
Error: LAN mode requires mDNS publishing, which is not supported on this platform.
```

#### Trusting the certificate on the phone

LAN mode uses Portless's own CA, which other devices do not know about. An
untrusted certificate blocks the camera, so the phone needs the CA installed
once.

The CA lives in Portless's state directory — `portless doctor` prints the path,
typically:

| Platform      | Path                              |
| ------------- | --------------------------------- |
| macOS / Linux | `~/.portless/ca.pem`              |
| Windows       | `C:\Users\<you>\.portless\ca.pem` |

Copy `ca.pem` (**not** `ca-key.pem` — that is the private key and must never
leave the machine) to the phone by AirDrop, email, or a download link.

**iOS** takes two separate steps, and skipping the second is the usual reason
this appears not to work:

1. Open the file — iOS offers to install a profile.
2. Settings → General → VPN & Device Management → install it.
3. Settings → General → About → **Certificate Trust Settings** → enable full
   trust for `portless Local CA`.

Step 3 is a different screen from step 2. Without it the certificate is
installed but not trusted, and the camera still refuses.

**Android:** Settings → Security → Encryption & credentials → Install a
certificate → CA certificate. Android warns loudly about user-installed CAs;
that warning is accurate and worth removing the certificate afterwards.

#### Reaching it by name, not by IP

The certificate covers `localhost`, `*.localhost`, and `*.local` — so
`hanko.local` validates and `192.168.x.x` does **not**. The phone has to
resolve the hostname. iOS resolves `.local` natively; Android is less reliable
and may need the URL opened from a QR rather than typed.

## Walking the flow

1. **Phone:** open `/signin` and find your ATProto handle. It resolves against
   the public API and carries the DID — not the handle — as the identity the
   other device inherits.
2. **Second screen:** open `/tv` — a browser tab, a Pi, a Fire Stick. **Use the
   same tunnel URL**, not `localhost`. It shows a code and a QR and polls.
3. **Phone:** the approval screen opens a camera first. Point it at the QR, or
   tap "enter the code instead".
4. **Phone:** approve. If you scanned, you are asked to type the code first —
   if you typed it, you are not. See below.
5. **Phone:** you land on `/account`, where the new device appears as a row.
   Revoke it and its next request stops resolving.

Reloading `/tv` keeps the same code — the grant is bound to that browser, so a
refresh does not invalidate a code someone is halfway through typing.

## Why the confirmation step is conditional

RFC 8628 §5.4 asks the approval screen to confirm the user can see the device
they are authorizing. The reason it gives is specific:

> it is particularly important to confirm that the device is in the user's
> possession, **as the user no longer has to type in the code being displayed
> on the device manually**

The check exists to **replace** manual typing, not to duplicate it. So:

| How the code arrived | Confirmation  | Why                                            |
| -------------------- | ------------- | ---------------------------------------------- |
| Scanned, or a link   | type the code | nothing has proven the user can see the screen |
| Typed by hand        | none          | typing it already proved exactly that          |

Asking someone to re-type a code they just typed is friction that buys nothing,
and it is why Plex does not do it either. `hanko` ships both strategies; which
one applies is the host app's decision, made per flow rather than per install.

## The device list

`/account` is a protected route showing every device signed in to the account —
the half a device-flow demo usually leaves out. Approving a device is only half
a trust decision; the other half is seeing what you approved and taking it back.
Steam and Discord both ship this screen.

Revocation is real rather than cosmetic: the session store is the authority, so
a revoked device's next request simply stops resolving. The list updates in
place over Server-Sent Events, so approving on a phone visibly adds a row.

SSE rather than a WebSocket because the channel only ever flows server →
browser, it reconnects on its own, and it rides plain HTTP — so it works
through a tunnel with no upgrade negotiation.

Every transition is logged in the terminal running the dev server, so the flow
can be followed across three devices without attaching a debugger to any.

## The three surfaces

| Route      | Device                | What it does                                |
| ---------- | --------------------- | ------------------------------------------- |
| `/tv`      | the screen signing in | shows the code and QR, polls for approval   |
| `/link`    | your phone            | scans or accepts a code, confirms, approves |
| `/signin`  | your phone            | resolves an ATProto handle to a DID         |
| `/account` | your phone            | signed-in devices, revoke, sign out         |

`/tv` is inline CSS and dependency-free JavaScript, so it costs nothing on
modest hardware.

## What this demo takes shortcuts on

- **`MemoryDeviceGrantStore`** dies with the process and is not shared between
  instances. Correct for one Node process, wrong for the edge deployment this
  library targets — swap in `KvDeviceGrantStore`.
- **In-memory rate limiting.** Five attempts per minute per (IP, code), which
  is what makes the 4-character code safe — at ~17 bits it is trivially
  brute-forceable without a cap. Per-instance, so an attacker on a real
  deployment would spread attempts across instances; use a shared store there.
- **`checkOrigin: false`.** Astro rejects form-encoded POSTs whose `Origin`
  does not match, which is right for browser forms and wrong for the device
  endpoints — a Fire Stick sends no `Origin`, and the RFC requires form
  encoding. A production app should keep the check on and exempt only the two
  device routes.
- **Placeholder app IDs** in the association files. Replace them with a real
  `<TEAM_ID>.<BUNDLE_ID>` and Play-signed fingerprint and the same QR opens a
  native app instead of this page — no change to the payload.
- **Sign-in resolves a real handle but fakes the session.** `/signin` calls the
  public ATProto API for typeahead and handle resolution, so the DID it carries
  is genuinely yours — but it never proves you own it. A real app runs the
  ATProto OAuth flow against your PDS; this one just sets a cookie, which is
  enough to exercise the hand-off honestly without making the demo about OAuth.
- **The grant is bound to a cookie**, so reloading `/tv` keeps the same code.
  A real deployment would key it to whatever identifies the screen — a device
  registration, a kiosk id — rather than a browser cookie.
- **Sessions live in memory**, so they die with the process and are not shared
  between instances. Revocation is genuinely enforced, but only within one
  server; put them in the same store as the grants for anything real.
- **The QR scanner bundles a WASM ponyfill.** Safari has never shipped
  `BarcodeDetector`, so on an iPhone the ponyfill is the implementation rather
  than a fallback. It is imported dynamically, so only a page that opens a
  camera pays for it.

[portless]: https://github.com/vercel-labs/portless
