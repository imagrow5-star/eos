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
  | { kind: "under18" }
  | { kind: "invalid" };

/**
 * Understand an age answer however they said it: "24", "I'm 24", a birth year
 * ("2001"), a DOB ("12/05/2001", "5 May 2001"), or a legacy band chip.
 */
export function parseAgeText(raw: string): AgeParse {
  const t = raw.toLowerCase().trim();
  const compact = t.replace(/\s/g, "");
  const band = AGE_BANDS.find((b) => compact === b || compact.includes(b));
  if (band) return { kind: "band", band };

  const nowYear = new Date().getFullYear();

  // A 4-digit year anywhere (birth year alone, or inside a DOB)
  const ym = t.match(/\b(19\d{2}|20\d{2})\b/);
  if (ym) {
    const birthYear = parseInt(ym[1]!, 10);
    const age = nowYear - birthYear;
    if (age < 0 || age > 120) return { kind: "invalid" };
    if (age < 18) return { kind: "under18" };
    return { kind: "age", age, birthYear };
  }

  // A plain number — their age
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
    if (up === "UK" || up === "GB") return "UK";
    return isValidCountryCode(up) ? up : null;
  }
  const exact = reverseMap().get(lower);
  if (exact) return exact;
  // Forgiving contains-match for "the united kingdom", "I'm in India", …
  for (const [name, code] of reverseMap()) {
    if (name.length >= 4 && lower.includes(name)) return code;
  }
  return null;
}
