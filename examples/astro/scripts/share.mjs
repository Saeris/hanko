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

const findTunnelUrl = async (localPort, attempts = 40) => {
  for (let i = 0; i < attempts; i++) {
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
 * here BEFORE the tunnel exists. Letting Portless pick would mean parsing it
 * back out of another process's stdout, which is the kind of coupling that
 * breaks on a cosmetic logging change.
 */
const PORT = Number(process.env.PORT ?? 4792);

const child = spawn(
  `yarn`,
  [`portless`, `run`, `--name`, `hanko`, `--ngrok`, `astro`, `dev`],
  { stdio: `inherit`, shell: true, env: { ...process.env, PORT: String(PORT) } }
);

child.on(`exit`, (code) => {
  process.exit(code ?? 0);
});

const { url } = await findTunnelUrl(PORT);

if (url === null) {
  console.log(
    `\n  No ngrok tunnel found forwarding to port ${PORT}.\n` +
      `  The dev server is still running locally.\n\n` +
      `  If ngrok reported a session limit, an agent from an earlier run is\n` +
      `  probably still holding a slot. On Windows:\n\n` +
      `    taskkill /IM ngrok.exe /F\n`
  );
} else {
  console.log(
    `\n  Scan to open the demo on your phone:\n\n` +
      `${qrToTerminal(url)}\n\n  ${url}\n`
  );
}
