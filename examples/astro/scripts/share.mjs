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

/**
 * Read the tunnel URL from Portless's own output.
 *
 * The obvious approach — ask ngrok's inspection API — does not work, and the
 * reasons are worth recording because each looks solvable in isolation:
 *
 * 1. The API is per AGENT, not per machine. A second agent finds :4040 taken
 *    and moves to :4041, so the well-known port belongs to whichever agent
 *    started first, often an orphan.
 * 2. Every agent reports an https tunnel, so `proto` identifies nothing.
 * 3. Matching `config.addr` against our port narrows it — until a leftover
 *    agent is still forwarding to that same port, which a FIXED port makes
 *    routine rather than unlucky. Two tunnels, one destination, no way to
 *    tell the live one from the dead one.
 *
 * Every one of those is a symptom of inferring ownership from global state.
 * Portless knows which agent it started and prints the URL; reading the line
 * it already emits is both simpler and exact. The cost is that stdout must be
 * piped rather than inherited, so it is echoed through below.
 */
const NGROK_LINE = /ngrok\s+->\s+(https:\/\/\S+)/u;

/**
 * Fixed rather than left to Portless to auto-assign.
 *
 * Not for tunnel matching any more — Portless reports its own tunnel URL, so
 * nothing has to be matched. A stable port is just good DX: the localhost URL
 * stays the same between runs, so a browser tab survives a restart.
 *
 * It has to go through `--app-port`; Portless does not read `PORT` from the
 * environment.
 */
const PORT = Number(process.env.PORT ?? 4792);

/**
 * Piped rather than inherited, so this process can read the tunnel URL out of
 * Portless's output. Every line is echoed straight through, so the terminal
 * still shows exactly what Portless printed.
 */
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
  {
    stdio: [`inherit`, `pipe`, `pipe`],
    shell: true,
    // Its own process group on POSIX, so a tree kill can reach the
    // grandchildren. Windows uses taskkill /T instead.
    detached: process.platform !== `win32`
  }
);

/**
 * Make sure the child tree dies with us.
 *
 * The whole class of bugs this script kept hitting — stale tunnels, a port
 * already in use, ngrok's session limit exhausted by nobody — came from
 * processes outliving the terminal that started them. Killing the wrapper is
 * not enough: `yarn` spawns portless, which spawns ngrok and astro, and on
 * Windows only a tree kill reaches them.
 */
const killTree = () => {
  const { pid } = child;
  if (!pid || child.killed) return;
  if (process.platform === `win32`) {
    spawn(`taskkill`, [`/pid`, String(pid), `/T`, `/F`], {
      stdio: `ignore`
    });
  } else {
    // Negative pid signals the whole group, which is why the child is
    // detached: without its own group there is nothing to signal but itself,
    // and the grandchildren (ngrok, astro) survive.
    try {
      process.kill(-pid, `SIGTERM`);
    } catch {
      child.kill(`SIGTERM`);
    }
  }
};

for (const signal of [`SIGINT`, `SIGTERM`, `SIGHUP`]) {
  process.on(signal, () => {
    killTree();
    process.exit(0);
  });
}
process.on(`exit`, killTree);

/**
 * Echo the child through, watching for the line that names the tunnel.
 *
 * Printed once. Portless can re-announce its URL, and a second QR scrolling
 * the first off the screen is worse than none — the one still visible would be
 * the older of the two.
 */
let printed = false;

const printQr = (url) => {
  if (printed) return;
  printed = true;
  process.stdout.write(
    `\n  Scan to open the demo on your phone:\n\n` +
      `${qrToTerminal(url)}\n\n  ${url}\n\n`
  );
};

const watch = (stream, out) => {
  let buffered = ``;
  stream.on(`data`, (chunk) => {
    out.write(chunk);
    buffered += chunk.toString();

    const lines = buffered.split(/\r?\n/u);
    // Keep the last fragment: a URL split across two chunks would not match.
    buffered = lines.pop() ?? ``;

    for (const line of lines) {
      const match = NGROK_LINE.exec(line);
      const url = match?.[1];
      if (url) printQr(url);
    }
  });
};

watch(child.stdout, process.stdout);
watch(child.stderr, process.stderr);

child.on(`exit`, (code) => {
  if (!printed) {
    process.stdout.write(
      `\n  Portless exited before reporting an ngrok tunnel.\n\n` +
        `  If it said authentication is not configured, check that first —\n` +
        `  but it prints that for every ngrok failure, including the free\n` +
        `  plan's three-session limit. Leftover agents are the usual cause:\n\n` +
        `    taskkill /IM ngrok.exe /F        (Windows)\n` +
        `    pkill ngrok                      (macOS / Linux)\n\n`
    );
  }
  process.exit(code ?? 0);
});
