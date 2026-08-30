import type { APIRoute } from "astro";
import { createTokenHandler } from "@saeris/hanko/handlers";
import { createSession, hanko } from "../../../lib/hanko.js";

const handler = createTokenHandler({ server: hanko, createSession });

export const POST: APIRoute = async ({ request }) => handler(request);
