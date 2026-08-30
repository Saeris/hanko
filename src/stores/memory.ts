/**
 * In-memory grant store — development and tests only.
 *
 * State dies with the process and is not shared across instances, so this is
 * wrong for any deployment with more than one worker. It exists so the library
 * is runnable with zero infrastructure; real deployments supply a Redis /
 * Postgres / Durable Object adapter against the same interface.
 */

import type { DeviceGrant, DeviceGrantStore } from "../types.js";

export class MemoryDeviceGrantStore implements DeviceGrantStore {
  /** Keyed by device_code. */
  readonly #byDeviceCode = new Map<string, DeviceGrant>();
  /** user_code → device_code. Avoids scanning on the user-facing lookup. */
  readonly #userCodeIndex = new Map<string, string>();

  create(grant: DeviceGrant): void {
    this.#byDeviceCode.set(grant.device_code, grant);
    this.#userCodeIndex.set(grant.user_code, grant.device_code);
  }

  findByDeviceCode(deviceCode: string): DeviceGrant | null {
    return this.#byDeviceCode.get(deviceCode) ?? null;
  }

  findByUserCode(userCode: string): DeviceGrant | null {
    const deviceCode = this.#userCodeIndex.get(userCode);
    return deviceCode === undefined ? null : this.findByDeviceCode(deviceCode);
  }

  update(grant: DeviceGrant): void {
    this.#byDeviceCode.set(grant.device_code, grant);
  }

  /**
   * Drop grants past their deadline.
   *
   * Without this the maps grow without bound in a long-lived dev server. Both
   * indexes must be cleared together or the user_code index leaks entries
   * pointing at deleted grants.
   */
  prune(now: number): void {
    for (const [deviceCode, grant] of this.#byDeviceCode) {
      if (now >= grant.expiresAt) {
        this.#byDeviceCode.delete(deviceCode);
        this.#userCodeIndex.delete(grant.user_code);
      }
    }
  }

  /** Test affordance: current grant count. */
  get size(): number {
    return this.#byDeviceCode.size;
  }
}
