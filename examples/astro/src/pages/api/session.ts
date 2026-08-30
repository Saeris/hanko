import type { APIRoute } from "astro";
import { touchSession } from "../../lib/sessions.js";

/**
 * Is this bearer token still good?
 *
 * Stands in for whatever API a signed-in device would actually be calling. The
 * point is that revocation is enforced at the STORE: once a session is gone,
 * every request carrying its token gets a 401, which is how a device learns it
 * was signed out rather than sitting on a stale success screen.
 */
export const GET: APIRoute = ({ request }) => {
  const header = request.headers.get(`authorization`) ?? ``;
  const token = header.startsWith(`Bearer `) ? header.slice(7) : undefined;
  const session = touchSession(token);

  return session === null
    ? Response.json({ error: `unauthorized` }, { status: 401 })
    : Response.json(
        { subject: session.subject, device: session.device },
        { headers: { "cache-control": `no-store` } }
      );
};
