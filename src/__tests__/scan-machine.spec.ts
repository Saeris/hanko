import { describe, expect, it } from "vitest";
import {
  canTransitionScan,
  isScanSettled,
  scanTransition,
  type ScanState
} from "../scan/machine.js";

describe(`scan machine`, () => {
  it(`runs the ordinary path from idle to decoded`, () => {
    let state: ScanState = `idle`;
    state = scanTransition(state, { type: `START` });
    expect(state).toBe(`starting`);
    state = scanTransition(state, { type: `READY` });
    expect(state).toBe(`scanning`);
    state = scanTransition(state, { type: `DECODE`, value: `WDJB` });
    expect(state).toBe(`decoded`);
  });

  it(`ignores a decode that arrives after the session stopped`, () => {
    // WHY: this is a real race, not a hypothetical. A frame handed to the
    // decoder just before `stop()` resolves after teardown, and without the
    // table making it illegal, that late result would reopen a session the
    // consumer already tore down — firing an approval they cancelled.
    const stopped = scanTransition(`scanning`, { type: `STOP` });
    expect(stopped).toBe(`stopped`);
    expect(scanTransition(stopped, { type: `DECODE`, value: `WDJB` })).toBe(
      `stopped`
    );
  });

  it(`does not decode while paused`, () => {
    // WHY: same race, different cause. A frame queued before a pause must not
    // resolve after it — otherwise hiding the tab can still complete a scan.
    const paused = scanTransition(`scanning`, { type: `PAUSE` });
    expect(scanTransition(paused, { type: `DECODE`, value: `X` })).toBe(
      `paused`
    );
    expect(scanTransition(paused, { type: `RESUME` })).toBe(`scanning`);
  });

  it(`only accepts a denial while starting`, () => {
    // WHY: permission is resolved during startup. A DENY arriving mid-scan
    // would mean the camera was revoked, which is `camera-lost` — a different
    // message to the user, and one they cannot fix in browser settings.
    expect(scanTransition(`starting`, { type: `DENY` })).toBe(`denied`);
    expect(scanTransition(`scanning`, { type: `DENY` })).toBe(`scanning`);
  });

  it(`keeps denied and failed distinct`, () => {
    // WHY: they are different conversations. Denial asks the user to change a
    // setting; a fault does not. Collapsing them is how a permission prompt
    // gets reported as "something went wrong".
    expect(scanTransition(`starting`, { type: `DENY` })).toBe(`denied`);
    expect(
      scanTransition(`starting`, { type: `FAIL`, reason: `no-camera` })
    ).toBe(`failed`);
  });

  it(`treats every outcome as terminal`, () => {
    // WHY: derived from the table, so a state added without transitions is
    // terminal automatically rather than by remembering to list it here.
    for (const state of [`decoded`, `denied`, `failed`, `stopped`] as const) {
      expect(isScanSettled(state)).toBe(true);
      expect(scanTransition(state, { type: `START` })).toBe(state);
    }
    for (const state of [`idle`, `starting`, `scanning`, `paused`] as const) {
      expect(isScanSettled(state)).toBe(false);
    }
  });

  it(`reports what it would accept`, () => {
    expect(canTransitionScan(`idle`, `START`)).toBe(true);
    expect(canTransitionScan(`idle`, `DECODE`)).toBe(false);
    expect(canTransitionScan(`scanning`, `DECODE`)).toBe(true);
  });
});
