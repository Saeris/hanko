import type { APIRoute } from "astro";
import { digitalAssetLinks } from "@saeris/hanko";

// The fingerprint that matters in production is the PLAY-signed one from the
// Play Console, not a local keystore — Play App Signing re-signs the upload.
// A local-only fingerprint is why app links commonly work in debug and break
// after release.
export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      digitalAssetLinks(`gg.saeris.hanko.example`, [`AA:BB:CC:DD:EE:FF`])
    ),
    {
      headers: {
        "content-type": `application/json`,
        "cache-control": `public, max-age=3600`
      }
    }
  );
