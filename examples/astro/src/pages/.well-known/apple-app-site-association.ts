import type { APIRoute } from "astro";
import { appleAppSiteAssociation } from "@saeris/hanko";

// Served from a route rather than `public/` so the content-type is right:
// Apple requires `application/json` on a file with NO extension, and most
// static servers refuse to guess that.
//
// The IDs here are placeholders. Replace with `<TEAM_ID>.<BUNDLE_ID>` and the
// universal link opens the Expo app instead of this page — no change to the
// QR, which already encodes the https URL.
export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(appleAppSiteAssociation([`TEAMID.gg.saeris.hanko.example`])),
    {
      headers: {
        "content-type": `application/json`,
        "cache-control": `public, max-age=3600`
      }
    }
  );
