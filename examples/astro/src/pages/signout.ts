import type { APIRoute } from "astro";
import { SESSION_COOKIE, sessionToken } from "../lib/hanko.js";
import { revokeToken } from "../lib/sessions.js";

/**
 * Sign this browser out.
 *
 * Revokes the session in the STORE as well as clearing the cookie. Clearing
 * only the cookie would leave a live session behind — still listed on the
 * device screen, and still valid to anything holding that token.
 *
 * A POST rather than a GET: a link that signs you out can be triggered by a
 * prefetch or an image tag on another site, which is the classic CSRF-logout
 * nuisance.
 */
export const POST: APIRoute = ({ request, cookies, redirect }) => {
  const token = sessionToken(request);
  if (token !== undefined) revokeToken(token);

  cookies.delete(SESSION_COOKIE, { path: `/` });
  return redirect(`/`);
};
