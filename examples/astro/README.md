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

One-time setup: an ngrok account (free) and

```sh
ngrok config add-authtoken <token>
```

Then it is two runs, because the tunnel URL is not known until the tunnel is up
and the QR has to encode it:

```sh
# 1. Start it, and read the ngrok URL it prints.
yarn demo:share
#      ngrok -> https://1817-71-63-254-225.ngrok-free.app

# 2. Stop it (Ctrl+C), start again with that URL as the origin.
HANKO_ORIGIN=https://1817-71-63-254-225.ngrok-free.app yarn demo:share
```

**Free ngrok assigns a new URL on every restart**, so step 2's value is only
good for that session. Check the `/tv` page shows the ngrok host next to "Visit
this link in a browser" — if it says `localhost` or `hanko.localhost`, the QR
points somewhere your phone cannot reach and nothing will work.

Two things worth knowing: the tunnel is public while it runs, and free ngrok
interstitials a browser warning page on first visit. Tap through it once on the
phone.

### Option B — Portless LAN mode (macOS and Linux only)

```sh
portless proxy start --lan
portless run --name hanko
```

Serves at `https://hanko.local`, reachable from any device on the WiFi.

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

1. **Phone:** open `/signin` and enter anything. Whatever you enter becomes the
   identity the other device inherits.
2. **Second screen:** open `/tv` — a browser tab, a Pi, a Fire Stick. It shows
   a code and a QR and starts polling.
3. **Phone:** scan the QR, or open `/link` and type the code.
4. **Phone:** re-enter the code to confirm you can see the screen you are
   authorizing, then approve.
5. **Second screen:** the next poll picks it up and shows who it signed in as.

Every transition is logged in the terminal running the dev server, so the flow
can be followed across three devices without attaching a debugger to any.

## The three surfaces

| Route     | Device                | What it does                                    |
| --------- | --------------------- | ----------------------------------------------- |
| `/tv`     | the screen signing in | shows the code and QR, polls for approval       |
| `/link`   | your phone            | resolves the code, runs the challenge, approves |
| `/signin` | your phone            | stands in for the host app's real auth          |

`/tv` is inline CSS and dependency-free JavaScript, so it costs nothing on
modest hardware.

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
