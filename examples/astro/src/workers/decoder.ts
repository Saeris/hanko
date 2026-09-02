/**
 * The decoder, off the main thread.
 *
 * `serveDecoder` wires a worker scope to a decoder and nothing else: the
 * library supplies no camera, no frame pump and no DOM, which is what lets the
 * same code run here, on a server, or in a test. Everything above this file is
 * the application's job.
 */
import { serveDecoder } from "@saeris/hanko/scan/worker";

// No time budget. A worker has no main thread to block, so the ladder may run
// to exhaustion — which is worth roughly twenty points of recognition against
// the 120ms a synchronous decode has to respect.
serveDecoder(self, { timeBudgetMs: 0 });
