// ─── Country helpers for profile basics ──────────────────────────────────────
// The list is built from Intl.DisplayNames so we never hand-maintain names.
// Storage codes are ISO-3166 alpha-2, with the legacy "UK" alias the backend
// uses for United Kingdom.

export interface Country {
  code: string;
  name: string;
}

let cached: Country[] | null = null;

export function allCountries(): Country[] {
  if (cached) return cached;
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const list: Country[] = [];
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
      list.push({ code: code === "GB" ? "UK" : code, name });
    }
  }
  cached = list.sort((x, y) => x.name.localeCompare(y.name));
  return cached;
}

/** "IN" → "India", legacy "UK" → "United Kingdom". null for empty/"other"/unknown. */
export function countryName(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!c || c === "OTHER") return null;
  const iso = c === "UK" ? "GB" : c;
  if (!/^[A-Z]{2}$/.test(iso)) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(iso);
    return name && name !== iso ? name : null;
  } catch {
    return null;
  }
}

/**
 * A gentle guess from the browser locale — only when the locale carries an
 * explicit region (e.g. "en-IN"). Always shown as a suggestion to confirm,
 * never saved silently.
 */
export function suggestCountry(): Country | null {
  try {
    const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const tag of tags) {
      if (!tag) continue;
      const region = new Intl.Locale(tag).region;
      if (region && /^[A-Z]{2}$/.test(region)) {
        const code = region === "GB" ? "UK" : region;
        const name = countryName(code);
        if (name) return { code, name };
      }
    }
  } catch {
    /* suggestion only — never block on it */
  }
  return null;
}

export function searchCountries(query: string, limit = 8): Country[] {
  const t = query.trim().toLowerCase();
  if (!t) return [];
  const all = allCountries();
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(t));
  const contains = all.filter(
    (c) => !c.name.toLowerCase().startsWith(t) && c.name.toLowerCase().includes(t),
  );
  return [...starts, ...contains].slice(0, limit);
}
