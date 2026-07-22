import { describe, it, expect } from "vitest";
import {
  resolveSendZone,
  isValidTimeZone,
  COUNTRY_DEFAULT_ZONE,
  UNMAPPABLE_REGIONS,
} from "../timezone";

describe("resolveSendZone — device zone is primary", () => {
  it("uses a real device zone even when a country is present", () => {
    // Production has exactly this shape: India device zone, US country.
    const r = resolveSendZone("Asia/Calcutta", "US");
    expect(r).toEqual({ zone: "Asia/Calcutta", source: "device" });
  });

  it("trims whitespace around the device zone", () => {
    const r = resolveSendZone("  Europe/Paris  ", null);
    expect(r).toEqual({ zone: "Europe/Paris", source: "device" });
  });

  it("treats an invalid stored zone as absent and falls back to country", () => {
    const r = resolveSendZone("Not/AZone", "US");
    expect(r).toEqual({ zone: "America/New_York", source: "country" });
  });

  it("treats an invalid stored zone with no country as a hold", () => {
    const r = resolveSendZone("Not/AZone", "");
    expect(r.zone).toBeNull();
    expect(r.source).toBe("held");
  });
});

describe("resolveSendZone — 'UTC' placeholder triggers country fallback", () => {
  it("US → Eastern (most-populous zone)", () => {
    expect(resolveSendZone("UTC", "US")).toEqual({ zone: "America/New_York", source: "country" });
  });

  it("AU → Sydney (most-populous zone)", () => {
    expect(resolveSendZone("UTC", "AU")).toEqual({ zone: "Australia/Sydney", source: "country" });
  });

  it("legacy 'UK' alias → Europe/London", () => {
    expect(resolveSendZone("UTC", "UK")).toEqual({ zone: "Europe/London", source: "country" });
  });

  it("'GB' also → Europe/London", () => {
    expect(resolveSendZone("UTC", "GB")).toEqual({ zone: "Europe/London", source: "country" });
  });

  it("single-timezone country maps exactly (IN → Asia/Kolkata)", () => {
    expect(resolveSendZone("UTC", "IN")).toEqual({ zone: "Asia/Kolkata", source: "country" });
  });

  it("normalizes case and whitespace of the country code", () => {
    expect(resolveSendZone("UTC", " us ")).toEqual({ zone: "America/New_York", source: "country" });
    expect(resolveSendZone("UTC", "uk")).toEqual({ zone: "Europe/London", source: "country" });
  });

  it("empty device zone (not just 'UTC') also falls back to country", () => {
    expect(resolveSendZone("", "BR")).toEqual({ zone: "America/Sao_Paulo", source: "country" });
    expect(resolveSendZone(null, "JP")).toEqual({ zone: "Asia/Tokyo", source: "country" });
  });
});

describe("resolveSendZone — hold when neither is usable", () => {
  it("'UTC' placeholder + no country → held", () => {
    const r = resolveSendZone("UTC", "");
    expect(r).toEqual({ zone: null, source: "held", holdReason: "no-timezone-and-no-country" });
  });

  it("'UTC' placeholder + 'other' country → held", () => {
    const r = resolveSendZone("UTC", "other");
    expect(r).toEqual({ zone: null, source: "held", holdReason: "no-timezone-and-no-country" });
  });

  it("null everything → held", () => {
    expect(resolveSendZone(null, null).zone).toBeNull();
    expect(resolveSendZone(undefined, undefined).zone).toBeNull();
  });

  it("unknown / non-country code → held with country-not-mapped", () => {
    const r = resolveSendZone("UTC", "ZZ");
    expect(r).toEqual({ zone: null, source: "held", holdReason: "country-not-mapped" });
    // CLDR non-country regions must never be guessed at:
    expect(resolveSendZone("UTC", "EU").holdReason).toBe("country-not-mapped");
  });
});

describe("placeholder detection edge cases", () => {
  it("lowercase 'utc' still counts as the placeholder and triggers the fallback", () => {
    expect(resolveSendZone("utc", "US")).toEqual({ zone: "America/New_York", source: "country" });
  });

  it("'Etc/UTC' is a genuine browser-reported zone, not the placeholder", () => {
    expect(resolveSendZone("Etc/UTC", "US")).toEqual({ zone: "Etc/UTC", source: "device" });
  });
});

describe("legacy and newly-added region codes", () => {
  it("maps legacy codes a DisplayNames-based picker can store", () => {
    expect(resolveSendZone("UTC", "SU")).toEqual({ zone: "Europe/Moscow", source: "country" });
    expect(resolveSendZone("UTC", "ZR")).toEqual({ zone: "Africa/Kinshasa", source: "country" });
    expect(resolveSendZone("UTC", "AN")).toEqual({ zone: "America/Curacao", source: "country" });
    expect(resolveSendZone("UTC", "BU")).toEqual({ zone: "Asia/Yangon", source: "country" });
    expect(resolveSendZone("UTC", "YU")).toEqual({ zone: "Europe/Belgrade", source: "country" });
  });

  it("maps Sark (CQ — ISO code added 2023)", () => {
    expect(resolveSendZone("UTC", "CQ")).toEqual({ zone: "Europe/Guernsey", source: "country" });
  });
});

describe("picker parity — single source of truth", () => {
  it("every region the Intl.DisplayNames-based picker can store either resolves to a zone or is documented in UNMAPPABLE_REGIONS", () => {
    // Replicates the picker loop in artifacts/aanya/src/lib/countries.ts.
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    const holes: string[] = [];
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a) + String.fromCharCode(b);
        let name: string | undefined;
        try {
          name = dn.of(code);
        } catch {
          continue;
        }
        if (!name || name === code) continue;
        const stored = code === "GB" ? "UK" : code; // the picker stores "UK" for GB
        const r = resolveSendZone("UTC", stored);
        if (r.zone === null && !UNMAPPABLE_REGIONS.has(code)) holes.push(`${code} (${name})`);
      }
    }
    expect(holes).toEqual([]);
  });
});

describe("documented tradeoff — genuine-UTC devices", () => {
  it("a genuinely-UTC device with a country gets country timing (placeholder is indistinguishable)", () => {
    expect(resolveSendZone("UTC", "FR")).toEqual({ zone: "Europe/Paris", source: "country" });
  });
});

describe("COUNTRY_DEFAULT_ZONE map integrity", () => {
  it("every key is an ISO alpha-2 code and no legacy 'UK' key exists (alias handled in code)", () => {
    for (const key of Object.keys(COUNTRY_DEFAULT_ZONE)) {
      expect(key).toMatch(/^[A-Z]{2}$/);
    }
    expect(COUNTRY_DEFAULT_ZONE.UK).toBeUndefined();
    expect(COUNTRY_DEFAULT_ZONE.GB).toBe("Europe/London");
  });

  it("every mapped zone is accepted by the Intl runtime (catches typos across all ~240 entries)", () => {
    const bad: string[] = [];
    for (const [code, zone] of Object.entries(COUNTRY_DEFAULT_ZONE)) {
      if (!isValidTimeZone(zone)) bad.push(`${code} → ${zone}`);
    }
    expect(bad).toEqual([]);
  });

  it("multi-timezone countries use their most-populous zone", () => {
    expect(COUNTRY_DEFAULT_ZONE.US).toBe("America/New_York");
    expect(COUNTRY_DEFAULT_ZONE.AU).toBe("Australia/Sydney");
    expect(COUNTRY_DEFAULT_ZONE.CA).toBe("America/Toronto");
    expect(COUNTRY_DEFAULT_ZONE.BR).toBe("America/Sao_Paulo");
    expect(COUNTRY_DEFAULT_ZONE.RU).toBe("Europe/Moscow");
    expect(COUNTRY_DEFAULT_ZONE.MX).toBe("America/Mexico_City");
    expect(COUNTRY_DEFAULT_ZONE.ID).toBe("Asia/Jakarta");
  });

  it("covers every country seen in production plus the major markets", () => {
    for (const code of ["US", "GB", "AU", "IN", "CA", "NZ", "IE", "ZA", "SG", "AE", "DE", "FR"]) {
      expect(COUNTRY_DEFAULT_ZONE[code], `missing ${code}`).toBeTruthy();
    }
  });

  it("resolver never returns the placeholder 'UTC' as a zone", () => {
    for (const zone of Object.values(COUNTRY_DEFAULT_ZONE)) {
      expect(zone).not.toBe("UTC");
    }
    expect(resolveSendZone("UTC", "US").zone).not.toBe("UTC");
  });
});
