import type { APIRoute } from "astro";
import { authenticate, sessionToken } from "../../lib/hanko.js";
import { listSessions, subscribe } from "../../lib/sessions.js";

/**
 * Live device list, over Server-Sent Events.
 *
 * SSE rather than a WebSocket: this channel only ever flows server → browser,
 * it reconnects on its own, and it rides plain HTTP — so it works through a
 * tunnel or any proxy with no upgrade negotiation. A WebSocket would buy
 * bidirectionality nothing here needs.
 */
export const GET: APIRoute = ({ request }) => {
  const subject = authenticate(request);
  if (subject === null) {
    return Response.json({ error: `unauthorized` }, { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller): void {
      const send = (): void => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ sessions: listSessions(subject, sessionToken(request)) })}\n\n`
            )
          );
        } catch {
          // The client hung up mid-write. Cleanup happens via the abort
          // listener below; swallowing here avoids an unhandled rejection on
          // a perfectly ordinary disconnect.
        }
      };

      // Paint immediately rather than waiting for the first change, so the
      // list is populated on load without a separate fetch.
      send();
      const unsubscribe = subscribe(subject, send);

      // Keeps intermediaries from closing an idle connection. ngrok and most
      // proxies will drop a stream that says nothing for a minute or two.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 20_000);

      request.signal.addEventListener(`abort`, () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the disconnect itself.
        }
      });
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": `text/event-stream`,
      "cache-control": `no-store`,
      // Tells nginx and friends not to buffer, which would defeat the whole
      // point by holding events until the response ended.
      "x-accel-buffering": `no`
    }
  });
};
