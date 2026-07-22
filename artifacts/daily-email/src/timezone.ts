// ─── Send-zone resolution ─────────────────────────────────────────────────────
// Decides which IANA timezone to compute a user's "local morning" in.
//
// Priority:
//   1. Device timezone (most precise — production already has users whose
//      device zone differs from their country's obvious zone).
//   2. Country fallback — the stored "UTC" is the never-captured placeholder
//      default, so it triggers a lookup of the country's representative zone.
//      Single-timezone countries map exactly; multi-timezone countries map to
//      their most-populous zone (US → Eastern, Australia → Sydney, …).
//   3. Hold (zone: null) — neither a device zone nor a mappable country.
//      Emailing at 6–9 AM UTC would be the wrong morning almost everywhere.
//
// Known tradeoff: a genuinely-UTC device (rare) is indistinguishable from the
// placeholder, so such a user gets country timing (or is held). Self-corrects
// the moment they open the app — the browser re-syncs the real zone on mount.

export type HoldReason = "no-timezone-and-no-country" | "country-not-mapped";

export interface ZoneResolution {
  /** IANA zone to compute the user's local morning in, or null to hold. */
  zone: string | null;
  /** Where the zone came from. */
  source: "device" | "country" | "held";
  holdReason?: HoldReason;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveSendZone(
  deviceZone: string | null | undefined,
  country: string | null | undefined,
): ZoneResolution {
  const tz = (deviceZone ?? "").trim();
  // Case-insensitive placeholder check — our writers only ever store "UTC",
  // but a stray "utc" must not masquerade as a real device zone. "Etc/UTC"
  // is NOT the placeholder: no writer of ours produces it, so it can only be
  // a genuine browser-reported zone and keeps device precedence.
  if (tz && tz.toUpperCase() !== "UTC" && isValidTimeZone(tz)) {
    return { zone: tz, source: "device" };
  }

  const c = (country ?? "").trim().toUpperCase();
  if (!c || c === "OTHER") {
    return { zone: null, source: "held", holdReason: "no-timezone-and-no-country" };
  }

  const iso = LEGACY_COUNTRY_ALIASES[c] ?? c;
  const mapped = COUNTRY_DEFAULT_ZONE[iso];
  if (!mapped) {
    return { zone: null, source: "held", holdReason: "country-not-mapped" };
  }
  return { zone: mapped, source: "country" };
}

// Legacy / superseded ISO-3166 codes that Intl.DisplayNames still resolves to
// a real country name. The country picker is built on DisplayNames, so these
// are storable — each maps to the canonical code used in COUNTRY_DEFAULT_ZONE.
export const LEGACY_COUNTRY_ALIASES: Record<string, string> = {
  UK: "GB", // deliberate storage alias for United Kingdom
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

// Regions Intl.DisplayNames names that DELIBERATELY resolve to a hold:
// uninhabited territories with no tzdb zone, and non-country CLDR regions.
// A hold is honest; a guessed zone is not. The picker-parity unit test
// enforces that everything else DisplayNames can produce resolves to a zone.
export const UNMAPPABLE_REGIONS: ReadonlySet<string> = new Set([
  "BV", "CP", "HM",                         // uninhabited, no tzdb zone
  "EU", "EZ", "UN", "QO", "XA", "XB", "ZZ", // not countries
]);

// ─── ISO-3166 alpha-2 → representative IANA zone ─────────────────────────────
// Complete for every region code the country picker can produce (it is built
// from Intl.DisplayNames): current ISO codes live here, superseded codes are
// normalized through LEGACY_COUNTRY_ALIASES first, and the short list in
// UNMAPPABLE_REGIONS deliberately holds. Multi-timezone countries use their
// most-populous zone (marked).
export const COUNTRY_DEFAULT_ZONE: Record<string, string> = {
  AC: "Atlantic/St_Helena",   // Ascension Island (CLDR extra)
  AD: "Europe/Andorra",
  AE: "Asia/Dubai",
  AF: "Asia/Kabul",
  AG: "America/Antigua",
  AI: "America/Anguilla",
  AL: "Europe/Tirane",
  AM: "Asia/Yerevan",
  AO: "Africa/Luanda",
  AQ: "Antarctica/McMurdo",   // largest station
  AR: "America/Argentina/Buenos_Aires",
  AS: "Pacific/Pago_Pago",
  AT: "Europe/Vienna",
  AU: "Australia/Sydney",     // multi-zone: most populous (NSW)
  AW: "America/Aruba",
  AX: "Europe/Mariehamn",
  AZ: "Asia/Baku",
  BA: "Europe/Sarajevo",
  BB: "America/Barbados",
  BD: "Asia/Dhaka",
  BE: "Europe/Brussels",
  BF: "Africa/Ouagadougou",
  BG: "Europe/Sofia",
  BH: "Asia/Bahrain",
  BI: "Africa/Bujumbura",
  BJ: "Africa/Porto-Novo",
  BL: "America/St_Barthelemy",
  BM: "Atlantic/Bermuda",
  BN: "Asia/Brunei",
  BO: "America/La_Paz",
  BQ: "America/Kralendijk",
  BR: "America/Sao_Paulo",    // multi-zone: most populous
  BS: "America/Nassau",
  BT: "Asia/Thimphu",
  BW: "Africa/Gaborone",
  BY: "Europe/Minsk",
  BZ: "America/Belize",
  CA: "America/Toronto",      // multi-zone: most populous (Ontario)
  CC: "Indian/Cocos",
  CD: "Africa/Kinshasa",      // multi-zone: most populous (west)
  CF: "Africa/Bangui",
  CG: "Africa/Brazzaville",
  CH: "Europe/Zurich",
  CI: "Africa/Abidjan",
  CK: "Pacific/Rarotonga",
  CL: "America/Santiago",     // multi-zone: mainland
  CM: "Africa/Douala",
  CN: "Asia/Shanghai",        // single official zone
  CO: "America/Bogota",
  CQ: "Europe/Guernsey",      // Sark (ISO code added 2023)
  CR: "America/Costa_Rica",
  CU: "America/Havana",
  CV: "Atlantic/Cape_Verde",
  CW: "America/Curacao",
  CX: "Indian/Christmas",
  CY: "Asia/Nicosia",
  CZ: "Europe/Prague",
  DE: "Europe/Berlin",
  DG: "Indian/Chagos",        // Diego Garcia (CLDR extra)
  DJ: "Africa/Djibouti",
  DK: "Europe/Copenhagen",
  DM: "America/Dominica",
  DO: "America/Santo_Domingo",
  DZ: "Africa/Algiers",
  EA: "Africa/Ceuta",         // Ceuta & Melilla (CLDR extra)
  EC: "America/Guayaquil",    // multi-zone: mainland, most populous
  EE: "Europe/Tallinn",
  EG: "Africa/Cairo",
  EH: "Africa/El_Aaiun",
  ER: "Africa/Asmara",
  ES: "Europe/Madrid",        // multi-zone: mainland (Canaries separate)
  ET: "Africa/Addis_Ababa",
  FI: "Europe/Helsinki",
  FJ: "Pacific/Fiji",
  FK: "Atlantic/Stanley",
  FM: "Pacific/Chuuk",        // multi-zone: most populous state
  FO: "Atlantic/Faroe",
  FR: "Europe/Paris",         // metropolitan France
  GA: "Africa/Libreville",
  GB: "Europe/London",        // stored as legacy "UK" — normalized before lookup
  GD: "America/Grenada",
  GE: "Asia/Tbilisi",
  GF: "America/Cayenne",
  GG: "Europe/Guernsey",
  GH: "Africa/Accra",
  GI: "Europe/Gibraltar",
  GL: "America/Nuuk",         // multi-zone: most populous (capital)
  GM: "Africa/Banjul",
  GN: "Africa/Conakry",
  GP: "America/Guadeloupe",
  GQ: "Africa/Malabo",
  GR: "Europe/Athens",
  GS: "Atlantic/South_Georgia",
  GT: "America/Guatemala",
  GU: "Pacific/Guam",
  GW: "Africa/Bissau",
  GY: "America/Guyana",
  HK: "Asia/Hong_Kong",
  HN: "America/Tegucigalpa",
  HR: "Europe/Zagreb",
  HT: "America/Port-au-Prince",
  HU: "Europe/Budapest",
  IC: "Atlantic/Canary",      // Canary Islands (CLDR extra)
  ID: "Asia/Jakarta",         // multi-zone: most populous (Java)
  IE: "Europe/Dublin",
  IL: "Asia/Jerusalem",
  IM: "Europe/Isle_of_Man",
  IN: "Asia/Kolkata",
  IO: "Indian/Chagos",
  IQ: "Asia/Baghdad",
  IR: "Asia/Tehran",
  IS: "Atlantic/Reykjavik",
  IT: "Europe/Rome",
  JE: "Europe/Jersey",
  JM: "America/Jamaica",
  JO: "Asia/Amman",
  JP: "Asia/Tokyo",
  KE: "Africa/Nairobi",
  KG: "Asia/Bishkek",
  KH: "Asia/Phnom_Penh",
  KI: "Pacific/Tarawa",       // multi-zone: most populous (Gilberts)
  KM: "Indian/Comoro",
  KN: "America/St_Kitts",
  KP: "Asia/Pyongyang",
  KR: "Asia/Seoul",
  KW: "Asia/Kuwait",
  KY: "America/Cayman",
  KZ: "Asia/Almaty",          // most populous city (country unified UTC+5 in 2024)
  LA: "Asia/Vientiane",
  LB: "Asia/Beirut",
  LC: "America/St_Lucia",
  LI: "Europe/Vaduz",
  LK: "Asia/Colombo",
  LR: "Africa/Monrovia",
  LS: "Africa/Maseru",
  LT: "Europe/Vilnius",
  LU: "Europe/Luxembourg",
  LV: "Europe/Riga",
  LY: "Africa/Tripoli",
  MA: "Africa/Casablanca",
  MC: "Europe/Monaco",
  MD: "Europe/Chisinau",
  ME: "Europe/Podgorica",
  MF: "America/Marigot",
  MG: "Indian/Antananarivo",
  MH: "Pacific/Majuro",       // multi-zone: most populous
  MK: "Europe/Skopje",
  ML: "Africa/Bamako",
  MM: "Asia/Yangon",
  MN: "Asia/Ulaanbaatar",     // multi-zone: most populous
  MO: "Asia/Macau",
  MP: "Pacific/Saipan",
  MQ: "America/Martinique",
  MR: "Africa/Nouakchott",
  MS: "America/Montserrat",
  MT: "Europe/Malta",
  MU: "Indian/Mauritius",
  MV: "Indian/Maldives",
  MW: "Africa/Blantyre",
  MX: "America/Mexico_City",  // multi-zone: most populous
  MY: "Asia/Kuala_Lumpur",
  MZ: "Africa/Maputo",
  NA: "Africa/Windhoek",
  NC: "Pacific/Noumea",
  NE: "Africa/Niamey",
  NF: "Pacific/Norfolk",
  NG: "Africa/Lagos",
  NI: "America/Managua",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  NP: "Asia/Kathmandu",
  NR: "Pacific/Nauru",
  NU: "Pacific/Niue",
  NZ: "Pacific/Auckland",     // multi-zone: main islands
  OM: "Asia/Muscat",
  PA: "America/Panama",
  PE: "America/Lima",
  PF: "Pacific/Tahiti",       // multi-zone: most populous
  PG: "Pacific/Port_Moresby", // multi-zone: most populous
  PH: "Asia/Manila",
  PK: "Asia/Karachi",
  PL: "Europe/Warsaw",
  PM: "America/Miquelon",
  PN: "Pacific/Pitcairn",
  PR: "America/Puerto_Rico",
  PS: "Asia/Gaza",
  PT: "Europe/Lisbon",        // multi-zone: mainland
  PW: "Pacific/Palau",
  PY: "America/Asuncion",
  QA: "Asia/Qatar",
  RE: "Indian/Reunion",
  RO: "Europe/Bucharest",
  RS: "Europe/Belgrade",
  RU: "Europe/Moscow",        // multi-zone: most populous
  RW: "Africa/Kigali",
  SA: "Asia/Riyadh",
  SB: "Pacific/Guadalcanal",
  SC: "Indian/Mahe",
  SD: "Africa/Khartoum",
  SE: "Europe/Stockholm",
  SG: "Asia/Singapore",
  SH: "Atlantic/St_Helena",
  SI: "Europe/Ljubljana",
  SJ: "Arctic/Longyearbyen",
  SK: "Europe/Bratislava",
  SL: "Africa/Freetown",
  SM: "Europe/San_Marino",
  SN: "Africa/Dakar",
  SO: "Africa/Mogadishu",
  SR: "America/Paramaribo",
  SS: "Africa/Juba",
  ST: "Africa/Sao_Tome",
  SV: "America/El_Salvador",
  SX: "America/Lower_Princes",
  SY: "Asia/Damascus",
  SZ: "Africa/Mbabane",
  TA: "Atlantic/St_Helena",   // Tristan da Cunha (CLDR extra)
  TC: "America/Grand_Turk",
  TD: "Africa/Ndjamena",
  TF: "Indian/Kerguelen",
  TG: "Africa/Lome",
  TH: "Asia/Bangkok",
  TJ: "Asia/Dushanbe",
  TK: "Pacific/Fakaofo",
  TL: "Asia/Dili",
  TM: "Asia/Ashgabat",
  TN: "Africa/Tunis",
  TO: "Pacific/Tongatapu",
  TR: "Europe/Istanbul",
  TT: "America/Port_of_Spain",
  TV: "Pacific/Funafuti",
  TW: "Asia/Taipei",
  TZ: "Africa/Dar_es_Salaam",
  UA: "Europe/Kyiv",
  UG: "Africa/Kampala",
  UM: "Pacific/Midway",       // US outlying islands — essentially unpopulated
  US: "America/New_York",     // multi-zone: most populous (Eastern)
  UY: "America/Montevideo",
  UZ: "Asia/Tashkent",
  VA: "Europe/Vatican",
  VC: "America/St_Vincent",
  VE: "America/Caracas",
  VG: "America/Tortola",
  VI: "America/St_Thomas",
  VN: "Asia/Ho_Chi_Minh",
  VU: "Pacific/Efate",
  WF: "Pacific/Wallis",
  WS: "Pacific/Apia",
  XK: "Europe/Belgrade",      // Kosovo (CLDR region, no own tzdb zone — CET like Belgrade)
  YE: "Asia/Aden",
  YT: "Indian/Mayotte",
  ZA: "Africa/Johannesburg",
  ZM: "Africa/Lusaka",
  ZW: "Africa/Harare",
};
