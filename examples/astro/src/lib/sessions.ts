/**
 * Signed-in devices, and the ability to revoke them.
 *
 * The half a device-flow demo usually leaves out. Approving a device is only
 * half a trust decision — the other half is being able to see what you have
 * approved and take it back. Steam and Discord both ship exactly this list,
 * and it is the difference between a protocol demo and something you could
 * build an app on.
 *
 * In-memory, so it dies with the process. A real deployment puts this in the
 * same store as the grants; the interface is small enough that swapping it is
 * mechanical.
 */

/** A device that completed the flow and holds a live token. */
export interface DeviceSession {
  /** Opaque bearer token the device presents. Never leaves the server except
      to the device that earned it. */
  token: string;
  /** Who the device is signed in as. A DID, in this demo. */
  subject: string;
  /** Display handle, since a DID is unreadable in a list. */
  handle: string;
  /** Which client asked — `demo-tv` here. Real apps have several. */
  clientId: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last poll or API call, so "last seen" is meaningful. */
  lastSeenAt: number;
  /** Coarse device description, from the User-Agent. */
  device: string;
}

/** What a client is safe to see. No token — that is the credential itself. */
export interface PublicSession {
  id: string;
  handle: string;
  clientId: string;
  createdAt: number;
  lastSeenAt: number;
  device: string;
  /** True for the session making the request, so a UI can say "this device". */
  current: boolean;
}

const sessions = new Map<string, DeviceSession>();

/**
 * A readable device name from the User-Agent.
 *
 * Deliberately coarse. The point is helping someone recognise which row is
 * which — "iPhone · Safari" does that; a full UA string does not, and parsing
 * one properly is a library's worth of work for a label.
 */
export const describeDevice = (userAgent: string | null): string => {
  if (userAgent === null || userAgent.length === 0) return `Unknown device`;

  const platform = /iPhone/u.test(userAgent)
    ? `iPhone`
    : /iPad/u.test(userAgent)
      ? `iPad`
      : /Android/u.test(userAgent)
        ? `Android`
        : /Macintosh|Mac OS/u.test(userAgent)
          ? `Mac`
          : /Windows/u.test(userAgent)
            ? `Windows`
            : /Linux/u.test(userAgent)
              ? `Linux`
              : `Unknown device`;

  // Order matters: Chrome and Edge both claim Safari, Edge claims Chrome.
  const browser = /Edg\//u.test(userAgent)
    ? `Edge`
    : /OPR\//u.test(userAgent)
      ? `Opera`
      : /Firefox\//u.test(userAgent)
        ? `Firefox`
        : /Chrome\//u.test(userAgent)
          ? `Chrome`
          : /Safari\//u.test(userAgent)
            ? `Safari`
            : null;

  return browser === null ? platform : `${platform} · ${browser}`;
};

/** Mint a session for a device that just completed the flow. */
export const createDeviceSession = ({
  subject,
  handle,
  clientId,
  userAgent,
  now = Date.now()
}: {
  subject: string;
  handle: string;
  clientId: string;
  userAgent: string | null;
  now?: number;
}): DeviceSession => {
  const session: DeviceSession = {
    // Same generator the library uses for device codes: 256 bits, URL-safe.
    // A session token is a bearer credential and deserves the same entropy.
    token:
      crypto.randomUUID().replaceAll(`-`, ``) +
      crypto.randomUUID().replaceAll(`-`, ``),
    subject,
    handle,
    clientId,
    createdAt: now,
    lastSeenAt: now,
    device: describeDevice(userAgent)
  };
  sessions.set(session.token, session);
  notify(subject);
  return session;
};

/**
 * Look up a session and mark it seen.
 *
 * Returns null for a revoked or unknown token, which is what makes revocation
 * take effect: the device's next poll simply stops resolving.
 */
export const touchSession = (
  token: string | undefined,
  now = Date.now()
): DeviceSession | null => {
  if (token === undefined) return null;
  const session = sessions.get(token);
  if (session === undefined) return null;
  session.lastSeenAt = now;
  return session;
};

/** Every live session for a subject, newest first. */
export const listSessions = (
  subject: string,
  currentToken?: string
): PublicSession[] =>
  [...sessions.values()]
    .filter((session) => session.subject === subject)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((session) => ({
      // The token identifies the session, but handing it to the client would
      // hand over the credential. A hash-free prefix is enough to address a
      // row without being usable as one.
      id: session.token.slice(0, 12),
      handle: session.handle,
      clientId: session.clientId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      device: session.device,
      current: session.token === currentToken
    }));

/**
 * Revoke one session by its public id.
 *
 * Scoped to a subject so one account cannot revoke another's device by
 * guessing an id — the ids are short by design, and the scope is what makes
 * that safe.
 */
export const revokeSession = (subject: string, id: string): boolean => {
  for (const [token, session] of sessions) {
    if (session.subject === subject && token.startsWith(id)) {
      sessions.delete(token);
      notify(subject);
      return true;
    }
  }
  return false;
};

/** Revoke every session for a subject. The "sign out everywhere" button. */
export const revokeAll = (subject: string, except?: string): number => {
  let count = 0;
  for (const [token, session] of sessions) {
    if (session.subject === subject && token !== except) {
      sessions.delete(token);
      count += 1;
    }
  }
  if (count > 0) notify(subject);
  return count;
};

/**
 * Listeners waiting on changes, keyed by subject.
 *
 * Lets the account screen update in place — approving on a phone visibly adds
 * a row on the dashboard without a refresh. Per-subject so one account's
 * changes never wake another's stream.
 */
const listeners = new Map<string, Set<() => void>>();

/** Watch a subject's sessions. Returns the unsubscribe. */
export const subscribe = (
  subject: string,
  onChange: () => void
): (() => void) => {
  const set = listeners.get(subject) ?? new Set();
  set.add(onChange);
  listeners.set(subject, set);

  return () => {
    set.delete(onChange);
    // Dropped entirely when empty, so the map does not accumulate one entry
    // per account that ever opened the page.
    if (set.size === 0) listeners.delete(subject);
  };
};

const notify = (subject: string): void => {
  for (const listener of listeners.get(subject) ?? []) listener();
};
