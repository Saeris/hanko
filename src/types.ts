/**
 * Wire types for the OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * Field names are the spec's, not ours — they cross the network to clients we
 * do not control, so they are forever-identifiers. Do not rename them to fit
 * local style.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628
 */

import type { GrantState } from "./machine.js";

/** RFC 8628 §3.2 — device authorization response. */
export interface DeviceAuthorizationResponse {
  /** High-entropy secret the device polls with. Never shown to the user. */
  device_code: string;
  /** Short code the user reads off the screen and types (or verifies). */
  user_code: string;
  /** Where the user goes to authorize. */
  verification_uri: string;
  /**
   * `verification_uri` with the `user_code` embedded, for QR/NFC.
   * OPTIONAL in the spec; we always emit it because the QR path is the point.
   */
  verification_uri_complete?: string;
  /** Lifetime in seconds of BOTH codes. */
  expires_in: number;
  /** Minimum seconds between polls. Spec default is 5. */
  interval: number;
}

/** RFC 8628 §3.5 — token endpoint error codes for this grant. */
export type DeviceAuthorizationError =
  /** Keep polling; the user has not finished yet. */
  | `authorization_pending`
  /** Keep polling, but permanently add 5s to the interval. */
  | `slow_down`
  /** Stop. The user said no. */
  | `access_denied`
  /** Stop. The codes aged out. */
  | `expired_token`;

/** The grant type URN. Sent verbatim as `grant_type`. */
export const DEVICE_CODE_GRANT_TYPE =
  `urn:ietf:params:oauth:grant-type:device_code` as const;

/**
 * Lifecycle of one authorization attempt.
 *
 * Aliased from `machine.ts`, which owns the states and the legal transitions
 * between them. Kept under its record-field name so a store adapter can type
 * its status column without importing the machine.
 */
export type GrantStatus = GrantState;

/**
 * A stored authorization attempt.
 *
 * `subject` is whatever the host app uses to identify the approving user (a
 * DID, a user id, a session id). hanko never interprets it — it only carries it
 * from the approving device back to the polling device.
 */
export interface DeviceGrant {
  device_code: string;
  user_code: string;
  status: GrantStatus;
  /** Epoch ms. Compared against an injected clock, never `Date.now()` directly. */
  expiresAt: number;
  /** Seconds. Mutable: `slow_down` raises it. */
  interval: number;
  /** OAuth client that started the flow, if the host app tracks clients. */
  clientId?: string;
  /** Requested scopes, uninterpreted. */
  scope?: string;
  /** Set when status becomes `approved`. */
  subject?: string;
  /** Epoch ms of the last poll, for `slow_down` enforcement. */
  lastPolledAt?: number;
}

/**
 * Persistence boundary.
 *
 * Deliberately tiny so adapters (Redis, Supabase, Better-Auth, Durable Objects)
 * are trivial. All methods may be async. Lookup by BOTH codes is required: the
 * device polls by `device_code`, the user approves by `user_code`.
 */
export interface DeviceGrantStore {
  create(grant: DeviceGrant): Promise<void> | void;
  findByDeviceCode(
    deviceCode: string
  ): Promise<DeviceGrant | null> | DeviceGrant | null;
  findByUserCode(
    userCode: string
  ): Promise<DeviceGrant | null> | DeviceGrant | null;
  update(grant: DeviceGrant): Promise<void> | void;
  /** Drop expired grants. Called opportunistically; may be a no-op with TTL stores. */
  prune?(now: number): Promise<void> | void;
}
