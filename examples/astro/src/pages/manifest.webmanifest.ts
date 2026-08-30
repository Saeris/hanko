import type { APIRoute } from "astro";
import { pwaLaunchHandler } from "@saeris/hanko";

// A route rather than a static file so `launch_handler` comes from the library
// — the fragment is small, but it is the difference between a scanned link
// reusing the open window and stacking a second one behind it.
export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      name: `hanko demo`,
      short_name: `hanko`,
      start_url: `/`,
      display: `standalone`,
      background_color: `#160c1e`,
      theme_color: `#160c1e`,
      icons: [],
      ...pwaLaunchHandler()
    }),
    { headers: { "content-type": `application/manifest+json` } }
  );
