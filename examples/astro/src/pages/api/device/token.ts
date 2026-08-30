import type { APIRoute } from "astro";
import { createTokenHandler } from "@saeris/hanko/handlers";
import { hanko, subjectHandle } from "../../../lib/hanko.js";
import { createDeviceSession } from "../../../lib/sessions.js";

// Built per request rather than once at module load, because minting the
// session needs this request's User-Agent — that is the only chance to learn
// what kind of device is signing in, and telling one device from another is
// the whole point of the account screen.
export const POST: APIRoute = async ({ request }) =>
  createTokenHandler({
    server: hanko,
    createSession: (subject) => {
      const session = createDeviceSession({
        subject,
        handle: subjectHandle(subject),
        clientId: `demo-tv`,
        userAgent: request.headers.get(`user-agent`)
      });

      // The shape RFC 6749 expects. The device stores this and presents it
      // back; revoking the session on the account screen makes it stop
      // resolving, which is what makes revocation real rather than cosmetic.
      return {
        access_token: session.token,
        token_type: `Bearer`,
        subject: session.handle
      };
    }
  })(request);
