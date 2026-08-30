/**
 * Grant store over any TTL-capable key-value service.
 *
 * The shape Upstash Redis, Cloudflare Workers KV, Deno KV, Vercel KV, and
 * plain `ioredis` all satisfy — three methods, one of which takes a TTL. That
 * is deliberately the lowest common denominator, so an adapter is a few lines
 * rather than a package.
 *
 * Suits stateless edge functions specifically: nothing is cached in the
 * instance, so a flow survives its requests landing on different workers, and
 * TTL expiry means abandoned grants cost nothing to clean up.
 */

import type { DeviceGrant, DeviceGrantStore } from "../types.js";

/** What hanko needs from a KV service. */
export interface KeyValueAdapter {
  get(key: string): Promise<string | null>;
  /** `ttlSeconds` is a hint; stores without TTL may ignore it (see below). */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface KvDeviceGrantStoreOptions {
  kv: KeyValueAdapter;
  /** Namespace, so grants cannot collide with the host app's own keys. */
  prefix?: string;
  /**
   * Extra seconds to keep a grant past its own deadline.
   *
   * Without this, a grant vanishes at the instant it expires and the device's
   * next poll gets "unknown code" — indistinguishable from a typo. The grace
   * window lets the server answer `expired_token` honestly, which is what a
   * client needs to stop cleanly rather than retry.
   */
  graceSeconds?: number;
  now?: () => number;
}

/**
 * Two keys per grant: `device:<code>` holds the record, `user:<code>` points at
 * it.
 *
 * A pointer rather than a duplicate, because the record changes on every poll
 * and two copies would diverge — the device would see a raised interval the
 * approval page did not.
 */
export class KvDeviceGrantStore implements DeviceGrantStore {
  readonly #kv: KeyValueAdapter;
  readonly #prefix: string;
  readonly #graceSeconds: number;
  readonly #now: () => number;

  constructor({
    kv,
    prefix = `hanko`,
    graceSeconds = 60,
    now = (): number => Date.now()
  }: KvDeviceGrantStoreOptions) {
    this.#kv = kv;
    this.#prefix = prefix;
    this.#graceSeconds = graceSeconds;
    this.#now = now;
  }

  #deviceKey(code: string): string {
    return `${this.#prefix}:device:${code}`;
  }

  #userKey(code: string): string {
    return `${this.#prefix}:user:${code}`;
  }

  /** Seconds until this grant may be dropped. At least 1 — never 0 or negative. */
  #ttl(grant: DeviceGrant): number {
    const remaining = Math.ceil((grant.expiresAt - this.#now()) / 1000);
    return Math.max(1, remaining + this.#graceSeconds);
  }

  async create(grant: DeviceGrant): Promise<void> {
    const ttl = this.#ttl(grant);
    await this.#kv.set(
      this.#deviceKey(grant.device_code),
      JSON.stringify(grant),
      ttl
    );
    await this.#kv.set(this.#userKey(grant.user_code), grant.device_code, ttl);
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceGrant | null> {
    const raw = await this.#kv.get(this.#deviceKey(deviceCode));
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      // Validated rather than asserted: this value came back from a shared
      // store that another deploy — or an older version of this library — may
      // have written. A half-shaped record would fail deep inside the machine
      // instead of here.
      return isDeviceGrant(parsed) ? parsed : null;
    } catch {
      // A corrupt value is not a live grant. Returning null lets the caller
      // report `expired_token` rather than crashing an edge function.
      return null;
    }
  }

  async findByUserCode(userCode: string): Promise<DeviceGrant | null> {
    const deviceCode = await this.#kv.get(this.#userKey(userCode));
    return deviceCode === null ? null : this.findByDeviceCode(deviceCode);
  }

  async update(grant: DeviceGrant): Promise<void> {
    // Rewrites the TTL on every update, which keeps the key alive exactly as
    // long as the grant's own deadline says — not as long as the last write
    // happened to leave it.
    await this.#kv.set(
      this.#deviceKey(grant.device_code),
      JSON.stringify(grant),
      this.#ttl(grant)
    );
  }

  /**
   * No-op: TTL is the pruning mechanism.
   *
   * Present so the interface is satisfied without a scan. Sweeping a KV store
   * for expired keys would cost a list operation per request to do worse than
   * what the service already does for free.
   */
  // Must stay an instance method to satisfy `DeviceGrantStore`; making it
  // static would take it off the interface.
  // oxlint-disable-next-line eslint/class-methods-use-this
  prune(): void {
    // Intentionally empty.
  }
}

/**
 * Adapter for a KV service whose `set` takes options rather than a TTL number.
 *
 * Covers Workers KV (`{ expirationTtl }`) and Vercel KV (`{ ex }`) without
 * either needing its own class.
 */
export const kvFromOptionsApi = ({
  get,
  set,
  remove,
  ttlKey = `expirationTtl`
}: {
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    options: Record<string, number>
  ) => Promise<void>;
  remove: (key: string) => Promise<void>;
  /** Option name carrying the TTL. `expirationTtl` for Workers KV, `ex` for Redis. */
  ttlKey?: string;
}): KeyValueAdapter => ({
  get,
  set: async (key, value, ttlSeconds) => {
    await set(key, value, { [ttlKey]: ttlSeconds });
  },
  delete: remove
});

/**
 * Structural check for a stored grant.
 *
 * Only the fields the machine cannot run without. Optional ones are left
 * unchecked — a missing `scope` costs a label on the approval screen, while a
 * missing `status` would put the state machine in an undefined state.
 */
const isDeviceGrant = (value: unknown): value is DeviceGrant =>
  typeof value === `object` &&
  value !== null &&
  `device_code` in value &&
  typeof value.device_code === `string` &&
  `user_code` in value &&
  typeof value.user_code === `string` &&
  `status` in value &&
  typeof value.status === `string` &&
  `expiresAt` in value &&
  typeof value.expiresAt === `number` &&
  `interval` in value &&
  typeof value.interval === `number`;
