# hanko Astro demo

The whole flow across three devices: a screen that cannot be typed into, a
phone that approves it, and an API in between.

## Run it

```sh
yarn demo
```

Then open <http://localhost:4321>. That builds the library first — the example
imports `@saeris/hanko` by its real package name and resolves through its
`exports` map, so it exercises the published artifact rather than reaching into
source.

## Run it across devices

The phone needs **HTTPS**, not just LAN access. Two reasons, both hard:

- `getUserMedia` (camera scanning) requires a secure context. `localhost` is
  exempt; `http://192.168.x.x` is **not**, so the camera silently never opens.
- Universal links and PWA install both need HTTPS with a real association file.

[Portless][portless] provides that locally:

```sh
npm install -g portless
yarn demo:lan
```

This serves at `https://hanko.local`, reachable from any device on the network.
Set `HANKO_ORIGIN` to match, because the QR encodes that origin — a QR pointing
at `localhost` is useless to the phone scanning it, which is the single easiest
way to make this demo look broken:

```sh
HANKO_ORIGIN=https://hanko.local yarn demo:lan
```

### Trusting the certificate on your phone

Portless generates a local CA and trusts it on the machine running it. Other
devices do not know about it, and an untrusted certificate blocks the camera —
so the phone needs it installed once:

1. Find the CA (`portless doctor` prints its path).
2. Get it onto the phone — AirDrop, email, or serve it over the LAN.
3. **iOS:** Settings → General → VPN & Device Management → install the profile,
   then Settings → General → About → **Certificate Trust Settings** and enable
   it there. The second step is separate and easy to miss; without it the
   certificate is installed but not trusted.
4. **Android:** Settings → Security → Encryption & credentials → Install a
   certificate → CA certificate.

## The three surfaces

| Route     | Device                | What it does                                    |
| --------- | --------------------- | ----------------------------------------------- |
| `/tv`     | the screen signing in | shows the code and QR, polls for approval       |
| `/link`   | your phone            | resolves the code, runs the challenge, approves |
| `/signin` | your phone            | stands in for the host app's real auth          |

Run `/tv` in a browser tab, on a Pi, or on a Fire Stick — the page is inline
CSS and dependency-free JavaScript, so it costs nothing on modest hardware.

## Walking the flow

1. Sign in at `/signin` on your phone. Whatever you enter becomes the identity
   the other device inherits.
2. Open `/tv` on a second device.
3. Scan its QR, or type the code at `/link`.
4. Re-enter the code to confirm you can see the screen you are authorizing,
   then approve.
5. The TV picks it up on its next poll and shows who it signed in as.

Transitions are logged in the terminal running the dev server, so the flow can
be followed across three devices without attaching a debugger to any of them.

## What this demo takes shortcuts on

- **`MemoryDeviceGrantStore`** dies with the process and is not shared between
  instances. Correct for one Node process, wrong for the edge deployment this
  library targets — swap in `KvDeviceGrantStore`.
- **No rate limiting.** RFC 8628 §5.1 requires it; the `rateLimit` seam on
  `createApprovalHandler` is where it goes. Left out because a demo has no
  shared store to hold counters.
- **`checkOrigin: false`.** Astro rejects form-encoded POSTs whose `Origin`
  does not match, which is right for browser forms and wrong for the device
  endpoints — a Fire Stick sends no `Origin`, and the RFC requires form
  encoding. A production app should keep the check on and exempt only the two
  device routes.
- **Placeholder app IDs** in the association files. Replace them with a real
  `<TEAM_ID>.<BUNDLE_ID>` and Play-signed fingerprint and the same QR opens a
  native app instead of this page — no change to the payload.
- **`authenticate` reads a cookie** set by a fake sign-in page. In a real app
  this reads your session, and whatever it returns is what the TV becomes.

[portless]: https://github.com/vercel-labs/portless
