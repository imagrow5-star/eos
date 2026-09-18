// ─── Profile basics: age & country helpers ───────────────────────────────────
// One home for parsing/validating the small personal facts a user shares
// (age, country — future basics belong here too). Country names come from
// Intl.DisplayNames so we never hand-maintain a country table.

/**
 * The only ageBand values that may ever be stored or interpolated into a
 * prompt. ageBand reaches system prompts, so free text must never land in it.
 */
export const AGE_BANDS = ["18-25", "26-35", "36-50", "50+"] as const;

export function ageToBand(age: number): string {
  return age >= 50 ? "50+" : age >= 36 ? "36-50" : age >= 26 ? "26-35" : "18-25";
}

export type AgeParse =
  | { kind: "age"; age: number; birthYear: number }
  | { kind: "band"; band: string } // legacy chip answers like "26-35"
  | { kind: "needsDate" } // a bare birth year at the 18 boundary — ask for the full date
  | { kind: "under18" }
  | { kind: "invalid" };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Exact age today from birth parts (month 1-12, day 1-31). */
export function ageFromParts(year: number, month: number, day: number, now = new Date()): number {
  let age = now.getFullYear() - year;
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if (m < month || (m === month && d < day)) age -= 1; // birthday hasn't happened yet this year
  return age;
}

function ageVerdict(age: number, birthYear: number): AgeParse {
  if (age < 0 || age > 120) return { kind: "invalid" };
  if (age < 18) return { kind: "under18" };
  return { kind: "age", age, birthYear };
}

/**
 * Understand an age answer however they said it: a date of birth
 * ("12/05/2001", "5 May 2001"), a bare birth year ("2001"), a plain age
 * ("24", "I'm 24"), or a legacy band chip ("26-35").
 *
 * When a full date is given, the age is exact (month and day are used for the
 * cutoff, then discarded — only the year and band are ever stored). A bare
 * year that lands on the 18 boundary can't be resolved without the date, so it
 * returns `needsDate` and the caller asks for the full date. `now` is
 * injectable for tests.
 */
export function parseAgeText(raw: string, now = new Date()): AgeParse {
  const t = (raw ?? "").toLowerCase().trim();
  const compact = t.replace(/\s/g, "");
  const band = AGE_BANDS.find((b) => compact === b || compact.includes(b));
  if (band) return { kind: "band", band };

  const nowYear = now.getFullYear();
  const ym = t.match(/\b(19\d{2}|20\d{2})\b/);

  if (ym) {
    const year = parseInt(ym[1]!, 10);
    // Pull day and month from what's left after removing the year, so the
    // year's own digits can never be mistaken for a day or month.
    const rest = t.replace(ym[0]!, " ");
    const monName = Object.keys(MONTHS).find((k) => rest.includes(k));
    const nums = (rest.match(/\d{1,2}/g) ?? []).map(Number);
    let month: number | undefined;
    let day: number | undefined;
    if (monName) {
      month = MONTHS[monName];
      day = nums.find((n) => n >= 1 && n <= 31);
    } else if (nums.length >= 2) {
      const [a, b] = nums as [number, number];
      if (a > 12) { day = a; month = b; }        // first > 12 must be the day
      else if (b > 12) { day = b; month = a; }   // second > 12 must be the day
      else { day = a; month = b; }               // ambiguous → day-first
    }
    if (month && day && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return ageVerdict(ageFromParts(year, month, day, now), year); // exact
    }

    // Bare year only: decide when it's unambiguous, else ask for the date.
    const ageMax = nowYear - year;   // birthday already passed this year
    const ageMin = ageMax - 1;       // birthday not yet this year
    if (ageMax < 0 || ageMax > 120) return { kind: "invalid" };
    if (ageMax < 18) return { kind: "under18" };
    if (ageMin >= 18) return { kind: "age", age: ageMin, birthYear: year };
    return { kind: "needsDate" };    // could be 17 or 18 — the date settles it
  }

  // A plain number — their stated age.
  const nm = t.match(/\b(\d{1,3})\b/);
  if (nm) {
    const age = parseInt(nm[1]!, 10);
    if (age < 5 || age > 120) return { kind: "invalid" }; // 1-4 isn't a real answer
    if (age < 18) return { kind: "under18" };
    return { kind: "age", age, birthYear: nowYear - age };
  }

  return { kind: "invalid" };
}

// ─── Country codes & names ────────────────────────────────────────────────────
// Storage format: ISO-3166 alpha-2 codes, with the legacy "UK" alias for
// United Kingdom (existing rows use it). Empty string = not shared;
// legacy rows may hold "other" which we treat as not shared.

let regionNames: Intl.DisplayNames | null = null;
function displayNames(): Intl.DisplayNames {
  if (!regionNames) regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  return regionNames;
}

/** "IN" → "India", "UK" → "United Kingdom". null for empty/"other"/unknown. */
export function countryDisplayName(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!c || c === "OTHER") return null;
  const iso = c === "UK" ? "GB" : c;
  if (!/^[A-Z]{2}$/.test(iso)) return null;
  try {
    const name = displayNames().of(iso);
    return name && name !== iso ? name : null;
  } catch {
    return null;
  }
}

export function isValidCountryCode(code: string): boolean {
  return countryDisplayName(code) !== null;
}

// Legacy / superseded ISO-3166 codes that Intl.DisplayNames still names — the
// picker can technically produce them, so they are normalized to their
// canonical modern code at write time. Must stay in sync with
// LEGACY_COUNTRY_ALIASES in the daily-email job (artifacts/daily-email/src/timezone.ts).
// "UK" is deliberately NOT here: it is our storage alias for GB, handled first.
export const LEGACY_COUNTRY_ALIASES: Record<string, string> = {
  AN: "CW", // Netherlands Antilles → Curaçao
  BU: "MM", // Burma → Myanmar
  CS: "RS", // Serbia and Montenegro → Serbia
  DD: "DE", // East Germany → Germany
  DY: "BJ", // Dahomey → Benin
  FX: "FR", // Metropolitan France → France
  HV: "BF", // Upper Volta → Burkina Faso
  NH: "VU", // New Hebrides → Vanuatu
  RH: "ZW", // Rhodesia → Zimbabwe
  SU: "RU", // Soviet Union → Russia
  TP: "TL", // East Timor → Timor-Leste
  VD: "VN", // North Vietnam → Vietnam
  YD: "YE", // South Yemen → Yemen
  YU: "RS", // Yugoslavia → Serbia
  ZR: "CD", // Zaire → DR Congo
};

/**
 * Validate + normalize a country value for storage. Accepts exactly what the
 * picker can produce: an ISO-3166 alpha-2 code named by Intl.DisplayNames
 * ("UK" stored for GB), the literal "other", or "" to clear. Legacy superseded
 * codes (SU, ZR, BU, …) are normalized to their canonical modern code so the
 * daily-email timezone fallback never sees them. Returns the storage value,
 * or null when the input is invalid (caller should reject the write).
 */
export function normalizeCountryForStorage(raw: string): string | null {
  const c = raw.trim().toUpperCase();
  if (c === "") return "";
  if (c === "OTHER") return "other";
  if (c === "UK" || c === "GB") return "UK";
  if (!/^[A-Z]{2}$/.test(c)) return null;
  const canonical = LEGACY_COUNTRY_ALIASES[c] ?? c;
  return isValidCountryCode(canonical) ? canonical : null;
}

// name (lowercased) → storage code. Built once by walking AA…ZZ through Intl.
let nameToCode: Map<string, string> | null = null;
function reverseMap(): Map<string, string> {
  if (nameToCode) return nameToCode;
  nameToCode = new Map();
  const dn = displayNames();
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
      nameToCode.set(name.toLowerCase(), code === "GB" ? "UK" : code);
    }
  }
  // Everyday aliases
  nameToCode.set("uk", "UK");
  nameToCode.set("britain", "UK");
  nameToCode.set("great britain", "UK");
  nameToCode.set("england", "UK");
  nameToCode.set("usa", "US");
  nameToCode.set("america", "US");
  nameToCode.set("united states of america", "US");
  return nameToCode;
}

/**
 * Turn a country answer (picker code or free text) into a storage code,
 * "skip", or null when we can't tell — we never guess a country.
 */
export function resolveCountryAnswer(raw: string): string | "skip" | null {
  const t = raw.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (
    lower === "skip" || lower.includes("prefer not") || lower.includes("rather not") ||
    lower.includes("not to say") || lower.includes("skip this")
  ) {
    return "skip";
  }
  const up = t.toUpperCase();
  if (/^[A-Z]{2}$/.test(up)) {
    const normalized = normalizeCountryForStorage(up);
    return normalized ? normalized : null;
  }
  const exact = reverseMap().get(lower);
  if (exact) return exact;
  // Forgiving contains-match for "the united kingdom", "I'm in India", …
  for (const [name, code] of reverseMap()) {
    if (name.length >= 4 && lower.includes(name)) return code;
  }
  return null;
}
