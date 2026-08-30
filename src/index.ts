/**
 * hanko — QR-assisted device sign-in (RFC 8628).
 *
 * Server core, state machines, and QR rendering. The two device-side halves are
 * separate entries so neither bundle carries server code:
 *
 * - `@saeris/hanko/client` — the device being signed in (TV, kiosk)
 * - `@saeris/hanko/approve` — the already-authenticated device granting it
 * - `@saeris/hanko/handlers` — Request→Response glue for edge runtimes
 * - `@saeris/hanko/stores/*` — persistence adapters
 */

export { HankoServer, createHankoServer } from "./server.js";
export type {
  ApproveResult,
  HankoServerOptions,
  PollResult
} from "./server.js";

export { Grant } from "./grant.js";
export type { GrantHooks } from "./grant.js";

// The machines are public: a host app may want to drive transitions itself —
// persisting state in a Durable Object, or rendering a screen straight from the
// state — without reimplementing the RFC's rules.
export {
  MAX_BACKOFF_SECONDS,
  SLOW_DOWN_INCREMENT_SECONDS,
  approvalTransition,
  canTransitionApproval,
  canTransitionGrant,
  canTransitionPoll,
  eventForTokenError,
  grantTransition,
  isApprovalSettled,
  isGrantSettled,
  isPollSettled,
  pollContextTransition,
  pollTransition
} from "./machine.js";
export type {
  ApprovalEvent,
  ApprovalState,
  GrantEvent,
  GrantState,
  PollContext,
  PollEvent,
  PollState
} from "./machine.js";

export {
  BASE20_ALPHABET,
  NUMERIC_ALPHABET,
  generateDeviceCode,
  generateUserCode,
  normalizeUserCode
} from "./codes.js";
export type { UserCodeOptions } from "./codes.js";

export { renderDeviceQr } from "./qr.js";
export type { DeviceQrOptions } from "./qr.js";

export { DEVICE_CODE_GRANT_TYPE } from "./types.js";
export type {
  DeviceAuthorizationError,
  DeviceAuthorizationResponse,
  DeviceGrant,
  DeviceGrantStore
} from "./types.js";

// App-opening: association files and link parsing. Exported from the root as
// well as `/approve` because the association files are generated on the SERVER
// (they must be served from the same origin as the approval page), while the
// parsing runs on the phone.
export {
  appleAppSiteAssociation,
  buildApprovalUrl,
  buildAppSchemeUrl,
  digitalAssetLinks,
  expoLinkingConfig,
  parseApprovalLink,
  pwaLaunchHandler
} from "./linking.js";
export type { LinkConfig, LinkSource, ParsedApprovalLink } from "./linking.js";
