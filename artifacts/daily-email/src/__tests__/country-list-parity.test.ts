// ─── Country-list drift guards ───────────────────────────────────────────────
// The legacy-country alias table exists in two places: the api-server's
// basics.ts (validates/normalizes country codes at profile write time) and
// this job's timezone.ts (resolves stored countries to timezones). These
// tests fail the moment one copy is edited without the other, and the moment
// a storable country code has no timezone mapping.

import { describe, it, expect } from "vitest";
import {
  LEGACY_COUNTRY_ALIASES as EMAIL_ALIASES,
  COUNTRY_DEFAULT_ZONE,
  UNMAPPABLE_REGIONS,
  isValidTimeZone,
} from "../timezone";
import {
  LEGACY_COUNTRY_ALIASES as API_ALIASES,
  normalizeCountryForStorage,
} from "../../../api-server/src/lib/basics";

describe("LEGACY_COUNTRY_ALIASES parity between api-server and daily-email", () => {
  it("the email job's table is exactly the api-server's table plus the deliberate UK→GB storage alias", () => {
    // api-server deliberately has no UK entry: "UK" is its *storage* alias
    // for GB (handled before the alias lookup). The email job must map the
    // stored "UK" back to GB, so its table is the api table + { UK: "GB" }.
    expect(EMAIL_ALIASES).toEqual({ ...API_ALIASES, UK: "GB" });
  });

  it("the api-server table never contains UK (UK is the storage alias, not a legacy code)", () => {
    expect(API_ALIASES).not.toHaveProperty("UK");
  });
});

describe("every storable country code resolves to a zone or a deliberate hold", () => {
  // Every alpha-2 code Intl.DisplayNames can name — the same universe the
  // country picker (and normalizeCountryForStorage) is built on.
  function allNamedCodes(): string[] {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    const codes: string[] = [];
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a) + String.fromCharCode(b);
        let name: string | undefined;
        try {
          name = dn.of(code);
        } catch {
          continue;
        }
        if (name && name !== code) codes.push(code);
      }
    }
    return codes;
  }

  it("every code normalizeCountryForStorage can emit is mapped or deliberately unmappable", () => {
    const storable = new Set<string>();
    for (const code of allNamedCodes()) {
      const stored = normalizeCountryForStorage(code);
      if (stored && stored !== "" && stored !== "other") storable.add(stored);
    }
    // "UK" is a storable output (the GB storage alias).
    expect(storable.has("UK")).toBe(true);

    const unaccounted: string[] = [];
    for (const stored of storable) {
      const iso = EMAIL_ALIASES[stored] ?? stored;
      const mapped = COUNTRY_DEFAULT_ZONE[iso];
      const heldDeliberately = UNMAPPABLE_REGIONS.has(iso);
      if (!mapped && !heldDeliberately) unaccounted.push(stored);
      if (mapped && heldDeliberately) unaccounted.push(`${stored} (both mapped AND unmappable)`);
    }
    expect(unaccounted).toEqual([]);
  });

  it("every mapped zone is a real IANA timezone", () => {
    const bad = Object.entries(COUNTRY_DEFAULT_ZONE)
      .filter(([, zone]) => !isValidTimeZone(zone))
      .map(([code, zone]) => `${code}: ${zone}`);
    expect(bad).toEqual([]);
  });
});
