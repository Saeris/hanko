// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import vercel from "@astrojs/vercel";

export default defineConfig({
  // Server-rendered: every endpoint here touches grant state, and a
  // statically-built page cannot poll or approve anything.
  output: "server",
  // Vercel in CI, Node locally. The adapters differ in how they serve — one
  // builds a serverless function, the other a standalone server — and the
  // local one is what `portless` proxies to for phone testing over TLS.
  adapter: process.env.VERCEL ? vercel() : node({ mode: "standalone" }),
  server: {
    // Bind all interfaces so the phone can reach the dev server. Portless
    // proxies to this and terminates TLS in front of it — the camera on the
    // approving device needs a secure context, which a bare LAN IP is not.
    host: true,
    port: 4321
  },
  security: {
    // Astro rejects form-encoded POSTs whose Origin does not match the host.
    // That is the right default for browser forms — but the device endpoints
    // are machine-to-machine: a Fire Stick posting to /api/device/token sends
    // no Origin at all, and RFC 8628 REQUIRES form encoding. The check would
    // reject every compliant client.
    //
    // Acceptable HERE because those endpoints are not state-changing on behalf
    // of a logged-in user. /api/link IS, and it is protected by the session
    // check in `authenticate` plus the confirmation challenge — not by Origin.
    // A production app should keep this on and exempt only the device routes.
    checkOrigin: false
  },
  vite: {
    server: {
      // Portless serves at https://hanko.local; Vite's HMR client has to be
      // told the public origin or it tries to reach the dev server directly
      // and the page reloads in a loop.
      allowedHosts: [".local", ".localhost"]
    }
  }
});
