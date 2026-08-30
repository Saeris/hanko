import type { APIRoute } from "astro";
import { authenticate, hanko, userCodeForDevice } from "../../lib/hanko.js";

/**
 * What device does this scanned identifier refer to?
 *
 * The QR carries a public handle derived from the grant's `device_code`, so a
 * scan tells the approving phone WHICH device is asking and nothing more. The
 * approval code is still read off that device's own screen, which is what a
 * photograph of the QR cannot supply.
 *
 * Deliberately does NOT return the user code. That is the whole point of the
 * split: knowing which device wants in is not the same as being able to let
 * it in.
 */
export const GET: APIRoute = async ({ request }) => {
  if (authenticate(request) === null) {
    return Response.json({ error: `unauthorized` }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get(`device`);
  if (id === null) {
    return Response.json({ error: `invalid_request` }, { status: 400 });
  }

  const userCode = userCodeForDevice(id);
  const grant =
    userCode === undefined ? null : await hanko.lookupByUserCode(userCode);

  if (!grant || grant.status !== `pending`) {
    return Response.json({ error: `unknown_device` }, { status: 404 });
  }

  return Response.json(
    { client_id: grant.clientId, scope: grant.scope },
    { headers: { "cache-control": `no-store` } }
  );
};
