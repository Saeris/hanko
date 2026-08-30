import type { APIRoute } from "astro";
import { authenticate, sessionToken } from "../../lib/hanko.js";
import { listSessions, revokeAll, revokeSession } from "../../lib/sessions.js";

/** The signed-in devices for this account. */
export const GET: APIRoute = ({ request }) => {
  const subject = authenticate(request);
  if (subject === null) {
    return Response.json({ error: `unauthorized` }, { status: 401 });
  }

  return Response.json(
    { sessions: listSessions(subject, sessionToken(request)) },
    { headers: { "cache-control": `no-store` } }
  );
};

/**
 * Revoke one device, or all of them.
 *
 * Scoped to the authenticated subject, so a guessed id cannot reach another
 * account's devices — the public ids are deliberately short, and the scope is
 * what makes that safe.
 */
export const POST: APIRoute = async ({ request }) => {
  const subject = authenticate(request);
  if (subject === null) {
    return Response.json({ error: `unauthorized` }, { status: 401 });
  }

  const form = new URLSearchParams(await request.text());
  const id = form.get(`id`);

  if (form.get(`all`) === `true`) {
    return Response.json({ revoked: revokeAll(subject) });
  }

  if (id === null) {
    return Response.json({ error: `invalid_request` }, { status: 400 });
  }

  return revokeSession(subject, id)
    ? Response.json({ revoked: 1 })
    : Response.json({ error: `not_found` }, { status: 404 });
};
