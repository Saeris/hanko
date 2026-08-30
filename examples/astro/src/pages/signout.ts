import type { APIRoute } from "astro";

/**
 * Clear this browser's session.
 *
 * A POST rather than a GET: a link that signs you out can be triggered by a
 * prefetch or an image tag on another site, which is the classic CSRF-logout
 * nuisance. Astro's Origin check covers this route since it is a real form.
 */
export const POST: APIRoute = ({ cookies, redirect }) => {
  cookies.delete(`demo_session`, { path: `/` });
  cookies.delete(`demo_did`, { path: `/` });
  return redirect(`/`);
};
