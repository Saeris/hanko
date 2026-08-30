/**
 * Start the demo behind a tunnel and print a scannable QR of the public URL.
 *
 * A wrapper rather than an Astro integration because `astro dev` daemonizes:
 * an integration's output lands in `astro dev logs`, which defeats the point of
 * printing a code you are meant to scan off the screen in front of you.
 *
 * This process owns the terminal, so it can wait for the tunnel and print
 * there — the way `expo start` does.
 */

import { spawn } from "node:child_process";
import { qrToTerminal } from "../src/lib/terminal-qr.ts";

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Ask ngrok what URL it handed out.
 *
 * Its local inspection API knows, so nothing has to be copied by hand. Portless
 * prints the tunnel URL but does not inject it, so this is the only way to get
 * it programmatically.
 */
// oxlint-disable no-await-in-loop
const findTunnelUrl = async (attempts = 40) => {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:4040/api/tunnels`);
      if (res.ok) {
        const body = await res.json();
        const https = body.tunnels?.find((t) => t.proto === `https`);
        if (https?.public_url) return https.public_url;
      }
    } catch {
      // Tunnel not up yet. Normal for the first few seconds.
    }
    await wait(500);
  }
  return null;
};
// oxlint-enable no-await-in-loop

const child = spawn(
  `yarn`,
  [`portless`, `run`, `--name`, `hanko`, `--ngrok`, `astro`, `dev`],
  { stdio: `inherit`, shell: true }
);

child.on(`exit`, (code) => {
  process.exit(code ?? 0);
});

const url = await findTunnelUrl();

if (url === null) {
  console.log(
    `\n  Could not find an ngrok tunnel on 127.0.0.1:4040.\n` +
      `  The dev server is still running locally.\n`
  );
} else {
  console.log(
    `\n  Scan to open the demo on your phone:\n\n` +
      `${qrToTerminal(url)}\n\n  ${url}\n`
  );
}
