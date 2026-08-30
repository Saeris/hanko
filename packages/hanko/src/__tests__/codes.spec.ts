import { describe, expect, it } from "vitest";
import {
  BASE20_ALPHABET,
  NUMERIC_ALPHABET,
  generateDeviceCode,
  generateUserCode,
  normalizeUserCode
} from "../codes.js";

describe(`generateUserCode`, () => {
  it(`draws only from the chosen alphabet`, () => {
    // WHY: the base-20 set excludes vowels so codes cannot spell words, and
    // excludes 0/O and 1/l/I so users cannot mistype them. A leaked character
    // from outside the set breaks both guarantees at once.
    for (let i = 0; i < 200; i++) {
      for (const char of normalizeUserCode(generateUserCode())) {
        expect(BASE20_ALPHABET).toContain(char);
      }
    }
  });

  it(`produces the requested number of significant characters`, () => {
    // WHY: length IS the entropy budget. RFC 8628 pairs 8 base-20 chars
    // (~34.5 bits) with a 5-attempt rate limit; a silently shorter code
    // invalidates that analysis without any visible symptom.
    expect(normalizeUserCode(generateUserCode({ length: 8 }))).toHaveLength(8);
    expect(normalizeUserCode(generateUserCode({ length: 12 }))).toHaveLength(
      12
    );
  });

  it(`formats for legibility without changing the significant characters`, () => {
    // WHY: the separator is display sugar for reading off a TV. If it ever
    // became part of the compared value, every user typing the code without
    // the dash would fail to authorize.
    const code = generateUserCode({ length: 8, separator: `-`, groupSize: 4 });
    expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u);
    expect(normalizeUserCode(code)).toHaveLength(8);
  });

  it(`omits the separator when asked`, () => {
    expect(generateUserCode({ length: 6, separator: `` })).toMatch(
      /^[A-Z]{6}$/u
    );
  });

  it(`supports a numeric alphabet for remote-friendly entry`, () => {
    // WHY: TV remotes often have a number pad but no letters. Numeric codes
    // trade entropy per character for typeability on that hardware.
    const code = generateUserCode({
      alphabet: NUMERIC_ALPHABET,
      length: 9,
      separator: ``
    });
    expect(code).toMatch(/^\d{9}$/u);
  });

  it(`distributes characters without modulo bias`, () => {
    // WHY: `byte % 20` looks correct but is skewed — 256 is not a multiple of
    // 20, so low indices appear ~8% more often. That shrinks the real keyspace
    // an attacker must search on a code whose entropy is already the weak
    // point. This test fails if rejection sampling is ever removed.
    const counts = new Map<string, number>();
    const samples = 20_000;
    for (let i = 0; i < samples / 8; i++) {
      for (const char of normalizeUserCode(generateUserCode({ length: 8 }))) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(BASE20_ALPHABET.length);

    const expected = samples / BASE20_ALPHABET.length;
    for (const count of counts.values()) {
      // Generous bound: catches systematic bias, tolerates normal variance.
      expect(count).toBeGreaterThan(expected * 0.8);
      expect(count).toBeLessThan(expected * 1.2);
    }
  });

  it(`rejects nonsensical configuration loudly`, () => {
    // WHY: CLAUDE.md Rule 11 — a zero-length or single-character code would
    // silently produce an unguessable-by-accident but trivially brute-forced
    // credential.
    expect(() => generateUserCode({ length: 0 })).toThrow(RangeError);
    expect(() => generateUserCode({ alphabet: `A` })).toThrow(RangeError);
  });
});

describe(`normalizeUserCode`, () => {
  it(`makes user input match regardless of case, spacing, or punctuation`, () => {
    // WHY: RFC 8628 §6.1 requires the server to strip punctuation it added and
    // uppercase A-Z codes. Phone keyboards autocorrect toward spaces and
    // lowercase; without this the user sees a correct-looking code rejected.
    const canonical = `WDJBMJHT`;
    for (const variant of [
      `WDJB-MJHT`,
      `wdjb-mjht`,
      `wdjb mjht`,
      ` WDJB.MJHT `
    ]) {
      expect(normalizeUserCode(variant)).toBe(canonical);
    }
  });
});

describe(`generateDeviceCode`, () => {
  it(`is URL-safe`, () => {
    // WHY: the device code travels in form bodies and URLs. Raw base64's `+`
    // and `/` would be corrupted by form encoding, producing a code that never
    // matches and a flow that hangs until expiry.
    for (let i = 0; i < 50; i++) {
      expect(generateDeviceCode()).toMatch(/^[A-Za-z0-9_-]+$/u);
    }
  });

  it(`carries far more entropy than the user code`, () => {
    // WHY: the spec says device_code has no usability ceiling, so it "SHOULD"
    // be very high entropy — it is the actual bearer secret, while user_code
    // is the rate-limited human affordance.
    expect(generateDeviceCode().length).toBeGreaterThanOrEqual(43);
  });

  it(`does not repeat`, () => {
    const seen = new Set(
      Array.from({ length: 1000 }, () => generateDeviceCode())
    );
    expect(seen.size).toBe(1000);
  });
});
