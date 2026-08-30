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
 * Two things make this harder than reading one endpoint. ngrok's inspection API
 * is per AGENT, not per machine: a second agent finds :4040 taken and quietly
 * moves to :4041, so the well-known port belongs to whichever agent started
 * first — often an orphan from an earlier run, since a killed wrapper does not
 * always take its tunnel with it. And every agent reports an https tunnel, so
 * "the first https one" identifies nothing.
 *
 * Both are fixed by the same fact: a tunnel records the local address it
 * forwards to. Ours is the one pointing at the port our dev server bound.
 * Scanning a few API ports and matching on `config.addr` is what makes the
 * printed QR provably the tunnel in front of us, rather than the oldest one
 * still lingering on the machine.
 */
// oxlint-disable no-await-in-loop
const AGENT_API_PORTS = [4040, 4041, 4042, 4043];

/** Tunnels from one agent, or `[]` if nothing is listening there. */
const tunnelsAt = async (apiPort) => {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
    if (!res.ok) return [];
    const body = await res.json();
    return body.tunnels ?? [];
  } catch {
    // No agent on this port. Expected for most of them.
    return [];
  }
};

const findTunnelUrl = async (localPort, isAlive, attempts = 40) => {
  for (let i = 0; i < attempts; i++) {
    // Stop the moment the child is gone. ngrok failing to start is the common
    // case — a session limit, usually — and continuing to poll after that can
    // only surface a tunnel that belongs to something else.
    if (!isAlive()) return { url: null, matched: false };

    const found = await Promise.all(AGENT_API_PORTS.map(tunnelsAt));
    const tunnels = found.flat().filter((t) => t.proto === `https`);

    // Identify by destination. `addr` is `http://127.0.0.1:<port>`, and the
    // port is what ties a tunnel to OUR dev server.
    const ours = tunnels.find((t) =>
      String(t.config?.addr ?? ``).endsWith(`:${localPort}`)
    );
    if (ours?.public_url) return { url: ours.public_url, matched: true };

    // Nothing matched yet, but tunnels exist: either ours is still coming up,
    // or these are all orphans. Keep waiting rather than printing one of them
    // — a QR for the wrong tunnel is worse than no QR, because it fails at the
    // phone with no hint as to why.
    await wait(500);
  }

  return { url: null, matched: false };
};
// oxlint-enable no-await-in-loop

/**
 * Fixed rather than left to Portless to choose.
 *
 * The port is how a tunnel is matched to this server, so it has to be known
 * here BEFORE the tunnel exists. Letting Portless auto-assign would mean
 * parsing it back out of another process's stdout, which is the kind of
 * coupling that breaks on a cosmetic logging change.
 *
 * It has to go through `--app-port`. Portless auto-assigns and does NOT read
 * `PORT` from the environment, so setting that pins nothing: the server comes
 * up on some other port, and a matcher looking for this one finds only a stale
 * tunnel from an earlier run that happens to still be forwarding to it.
 */
const PORT = Number(process.env.PORT ?? 4792);

const child = spawn(
  `yarn`,
  [
    `portless`,
    `run`,
    `--name`,
    `hanko`,
    `--app-port`,
    String(PORT),
    `--ngrok`,
    `astro`,
    `dev`
  ],
  { stdio: `inherit`, shell: true }
);

/**
 * Whether the child is still alive.
 *
 * Discovery reads a machine-global API that knows nothing about this run, so
 * without this it will happily poll for twenty seconds after Portless has
 * already died — and print a tunnel belonging to some other process. The QR
 * has to be a claim about THIS server, which means the server has to exist.
 */
let childAlive = true;

child.on(`exit`, (code) => {
  childAlive = false;
  process.exit(code ?? 0);
});

const { url } = await findTunnelUrl(PORT, () => childAlive);

/**
 * How many ngrok agents are already running.
 *
 * Worth knowing because Portless reports EVERY ngrok start failure as
 * "authentication is not configured", including the session limit — which is
 * a different problem with a different fix, and the far more likely one when
 * a previous run left agents behind. The free plan allows three.
 */
const orphanCount = (await Promise.all(AGENT_API_PORTS.map(tunnelsAt))).filter(
  (t) => t.length > 0
).length;

if (url === null) {
  console.log(
    `\n  No ngrok tunnel found forwarding to port ${PORT}.\n${
      orphanCount > 0
        ? `\n  ${orphanCount} ngrok agent(s) are already running. The free plan allows\n` +
          `  three at once, so a leftover from an earlier run can block a new\n` +
          `  tunnel — which Portless reports as "authentication is not\n` +
          `  configured" even when your token is fine. Clear them:\n\n` +
          `    taskkill /IM ngrok.exe /F        (Windows)\n` +
          `    pkill ngrok                      (macOS / Linux)\n`
        : `  The dev server is still running locally.\n`
    }`
  );
} else {
  console.log(
    `\n  Scan to open the demo on your phone:\n\n` +
      `${qrToTerminal(url)}\n\n  ${url}\n`
  );
}
