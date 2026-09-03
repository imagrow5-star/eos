/**
 * Sprint 1.6 — multilanguage crisis floor tests. LIFE-SAFETY LAYER.
 *
 * Per language: ≥5 positive phrases that MUST fire and ≥5 everyday negative
 * phrases (similar vocabulary, no crisis meaning) that must NOT fire — the
 * negatives run against the full union (language set + English), exactly how
 * production evaluates them. Plus: language routing, localized helpline
 * blocks, the golden system-prompt directive, TTS model routing, catalog
 * coverage, and two end-to-end German cycles (benign + crisis).
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, profileTable, isEncrypted, decryptText } from "@workspace/db";
import app from "../app.js";
import { detectCrisis, isCrisisText } from "../services/crisis/detector.js";
import { I18N_CRISIS_PATTERNS } from "../services/crisis/i18nPatterns.js";
import {
  HELPLINE_BLOCK_COPY,
  helplineBlockCopy,
  buildHelplineBlockText,
  markerForLanguage,
  resolveHelplines,
} from "../services/crisis/helplines.js";
import { buildLanguageDirective, buildSystemPrompt } from "../services/systemPrompt.js";
import { ttsModelForLanguage } from "../routes/tts.js";
import { LANGUAGES } from "../services/settings/languages.js";
import { voicesFor } from "../services/settings/voiceCatalog.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdEmails: string[] = [];

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (r.rowCount === 0) return;
  const uid = r.rows[0]!.id;
  await pool.query(`DELETE FROM crisis_events WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM messages WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}'`);
  await pool.query(`DELETE FROM profile WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM users WHERE id = ${uid}`);
}

afterAll(async () => {
  await Promise.all(createdEmails.splice(0).map(cleanupUser));
  await pool.end();
});

// ─── Per-language positive + negative phrase sweeps ──────────────────────────

const SWEEPS: Record<string, { fires: string[]; doesNot: string[] }> = {
  de: {
    fires: [
      "ich will nicht mehr leben",
      "ich bringe mich um",
      "ich denke ständig an selbstmord",
      "alle wären besser dran ohne mich",
      "ich will mir das leben nehmen",
      "ich will nicht mehr aufwachen",
    ],
    doesNot: [
      "ich bin heute so müde von der arbeit",
      "der film gestern war ziemlich langweilig",
      "ich will nicht mehr arbeiten heute abend",
      "mein handy ist schon wieder kaputt gegangen",
      "ich koche heute abend nudeln für uns",
    ],
  },
  nl: {
    fires: [
      "ik wil niet meer leven",
      "ik denk aan zelfmoord",
      "iedereen is beter af zonder mij",
      "ik wil er niet meer zijn",
      "ik wil er een einde aan maken",
    ],
    doesNot: [
      "ik ben moe van mijn werk vandaag",
      "de trein was weer eens te laat",
      "ik wil niet meer naar dat café gaan",
      "mijn plant is helaas doodgegaan",
      "we kijken vanavond samen een film",
    ],
  },
  fr: {
    fires: [
      "je veux mourir",
      "j'ai envie d'en finir",
      "je vais me suicider",
      "ils seraient mieux sans moi",
      "je ne veux plus être là",
    ],
    doesNot: [
      "je suis fatigué du travail cette semaine",
      "le film était nul hier soir",
      "je ne veux plus manger de sucre",
      "ma journée était vraiment longue",
      "je vais me coucher tôt ce soir",
    ],
  },
  es: {
    fires: [
      "quiero morirme",
      "no quiero seguir viviendo",
      "estarían mejor sin mí",
      "quiero acabar con todo",
      "pienso mucho en el suicidio",
    ],
    doesNot: [
      "estoy cansado del trabajo esta semana",
      "la película de anoche fue aburrida",
      "no quiero ir al gimnasio mañana",
      "mañana cocino pasta para todos",
      "mi jefe movió la reunión otra vez",
    ],
  },
  it: {
    fires: [
      "voglio morire",
      "voglio farla finita",
      "stanno tutti meglio senza di me",
      "non voglio più vivere",
      "penso spesso al suicidio",
    ],
    doesNot: [
      "sono stanco del lavoro questa settimana",
      "il film di ieri era noioso",
      "non voglio più mangiare dolci",
      "domani cucino la pasta per tutti",
      "il capo ha spostato la riunione",
    ],
  },
  pt: {
    fires: [
      "quero morrer",
      "não quero mais viver",
      "estariam melhor sem mim",
      "quero acabar com tudo",
      "penso muito em suicídio",
    ],
    doesNot: [
      "estou cansado do trabalho esta semana",
      "o filme de ontem foi chato",
      "não quero mais café hoje",
      "amanhã vou cozinhar para todos",
      "o chefe mudou a reunião de novo",
    ],
  },
  sv: {
    fires: [
      "jag vill dö",
      "jag vill inte leva längre",
      "de är bättre utan mig",
      "jag tänker på självmord",
      "jag vill ta livet av mig",
    ],
    doesNot: [
      "jag är trött på jobbet idag",
      "filmen igår var tråkig",
      "jag vill inte gå till festen",
      "imorgon lagar jag pasta",
      "tåget var försenat igen",
    ],
  },
  no: {
    fires: [
      "jeg vil dø",
      "jeg vil ikke leve lenger",
      "de er bedre uten meg",
      "jeg tenker på selvmord",
      "jeg vil ta livet mitt",
    ],
    doesNot: [
      "jeg er trøtt etter jobb i dag",
      "filmen i går var kjedelig",
      "jeg vil ikke gå på festen",
      "i morgen lager jeg middag",
      "toget var forsinket igjen",
    ],
  },
  da: {
    fires: [
      "jeg vil dø",
      "jeg vil ikke leve længere",
      "de er bedre uden mig",
      "jeg tænker på selvmord",
      "jeg vil tage mit eget liv",
    ],
    doesNot: [
      "jeg er træt efter arbejde i dag",
      "filmen i går var kedelig",
      "jeg vil ikke med til festen",
      "i morgen laver jeg mad",
      "toget var forsinket igen",
    ],
  },
  pl: {
    fires: [
      "chcę umrzeć",
      "nie chcę już żyć",
      "będzie im lepiej beze mnie",
      "myślę o samobójstwie",
      "chcę skończyć ze sobą",
    ],
    doesNot: [
      "jestem zmęczony pracą w tym tygodniu",
      "film wczoraj był nudny",
      "nie chcę już kawy dzisiaj",
      "jutro gotuję obiad dla rodziny",
      "szef przesunął spotkanie na piątek",
    ],
  },
};

describe("crisis detector — per-language sweeps", () => {
  const targetLangs = Object.keys(I18N_CRISIS_PATTERNS);

  it("covers exactly the ten activated languages", () => {
    expect(targetLangs.sort()).toEqual(["da", "de", "es", "fr", "it", "nl", "no", "pl", "pt", "sv"]);
    expect(Object.keys(SWEEPS).sort()).toEqual(targetLangs.sort());
  });

  for (const [lang, sweep] of Object.entries(SWEEPS)) {
    it(`${lang}: all positive crisis phrases fire (with the ${lang} pattern set)`, () => {
      expect(sweep.fires.length).toBeGreaterThanOrEqual(5);
      for (const phrase of sweep.fires) {
        const result = detectCrisis(phrase, lang);
        expect(result.matched, `should fire [${lang}]: "${phrase}"`).toBe(true);
        expect(result.pattern, phrase).toBeDefined();
      }
    });

    it(`${lang}: everyday phrases do NOT fire (full union: ${lang} + English)`, () => {
      expect(sweep.doesNot.length).toBeGreaterThanOrEqual(5);
      for (const phrase of sweep.doesNot) {
        expect(detectCrisis(phrase, lang).matched, `should NOT fire [${lang}]: "${phrase}"`).toBe(false);
      }
    });

    it(`${lang}: every pattern name is prefixed with its language`, () => {
      for (const p of I18N_CRISIS_PATTERNS[lang]!) {
        expect(p.name.startsWith(`${lang}_`), p.name).toBe(true);
        expect(p.source.length).toBeGreaterThan(3);
      }
    });
  }

  it("language routing: German phrases need the German set; English detection always runs", () => {
    // German-only phrase: fires for language=de, not for language=en.
    expect(detectCrisis("ich will nicht mehr leben", "de").matched).toBe(true);
    expect(detectCrisis("ich will nicht mehr leben", "en").matched).toBe(false);
    expect(detectCrisis("ich will nicht mehr leben").matched).toBe(false); // default en
    // Union: an ENGLISH crisis phrase still fires for a German-language user.
    expect(detectCrisis("I want to die", "de").matched).toBe(true);
    // Unknown/inactive codes fall back to English-only without throwing.
    expect(detectCrisis("I want to die", "fi").matched).toBe(true);
    expect(detectCrisis("ich will nicht mehr leben", "fi").matched).toBe(false);
  });

  it("isCrisisText (chapters/sealed notes) is the union of ALL languages", () => {
    expect(isCrisisText("ich will nicht mehr leben")).toBe(true);
    expect(isCrisisText("chcę umrzeć")).toBe(true);
    expect(isCrisisText("I had such a hard day at work today, everything went wrong.")).toBe(false);
  });
});

// ─── Localized helpline block ────────────────────────────────────────────────

describe("helpline block localization", () => {
  it("has copy for English + all ten target languages", () => {
    expect(Object.keys(HELPLINE_BLOCK_COPY).sort()).toEqual(
      ["da", "de", "en", "es", "fr", "it", "nl", "no", "pl", "pt", "sv"],
    );
    for (const [code, copy] of Object.entries(HELPLINE_BLOCK_COPY)) {
      expect(copy.intro.length, code).toBeGreaterThan(10);
      expect(copy.outro.length, code).toBeGreaterThan(5);
    }
  });

  it("builds a localized block with untranslated helpline lines", () => {
    const { lines } = resolveHelplines("DE");
    const block = buildHelplineBlockText(lines, "de");
    expect(block.startsWith("—\nJemand, der jetzt für dich da sein kann")).toBe(true);
    expect(block.endsWith("Ich gehe nirgendwohin. Lass dir Zeit.")).toBe(true);
    expect(block).toContain("TelefonSeelsorge"); // name/number untouched
    expect(block.startsWith(markerForLanguage("de"))).toBe(true);

    const pl = buildHelplineBlockText(resolveHelplines("PL").lines, "pl");
    expect(pl.startsWith("—\nKtoś, kto może być z Tobą teraz")).toBe(true);
  });

  it("falls back to English copy for unknown or inactive languages", () => {
    expect(helplineBlockCopy("fi")).toEqual(HELPLINE_BLOCK_COPY.en);
    expect(helplineBlockCopy("xx")).toEqual(HELPLINE_BLOCK_COPY.en);
    expect(helplineBlockCopy(null)).toEqual(HELPLINE_BLOCK_COPY.en);
    const block = buildHelplineBlockText(resolveHelplines("US").lines, "fi");
    expect(block.startsWith("—\nSomeone who can be with you right now")).toBe(true);
  });
});

// ─── System prompt language directive ────────────────────────────────────────

const GOLDEN_ES_DIRECTIVE = `══════════════════════════════════════════════════════
LANGUAGE
══════════════════════════════════════════════════════
The user's preferred language is Español.
You MUST respond in Español. Every reply. Every time. Without exception.

If the user writes in a different language (including English) — still reply in Español. Assume they can read Español because they explicitly chose it in Settings. If their message is unclear (voice transcription garbled, typos, mixed words) — ask for clarification IN Español. Never fall back to English on your own.

The only exceptions: (1) the user explicitly writes "please switch to English" or "réponds-moi en anglais" or similar, OR (2) the user changes their language preference in Settings. Both are signalled by the system, not inferred by you.

Your craft rules (mirroring tone, no clinical labels, no invented affirmations, no death metaphors, honest presence) apply identically in Español. If you don't know a word in Español, say so honestly rather than switching to English.`;

describe("system prompt language directive", () => {
  it("is byte-identical to the golden string for Spanish", () => {
    expect(buildLanguageDirective("es")).toBe(GOLDEN_ES_DIRECTIVE);
  });

  it("is absent for the REMOVED languages (sunset to en+es — see languages.ts)", () => {
    expect(buildLanguageDirective("de")).toBeNull();
    expect(buildLanguageDirective("fr")).toBeNull();
    expect(buildLanguageDirective("nl")).toBeNull();
  });

  it("is absent for English, inactive, and unknown languages", () => {
    expect(buildLanguageDirective("en")).toBeNull();
    expect(buildLanguageDirective("fi")).toBeNull(); // stored but inactive
    expect(buildLanguageDirective("xx")).toBeNull();
    expect(buildLanguageDirective(null)).toBeNull();
  });

  it("uses each language's native name", () => {
    for (const l of LANGUAGES.filter((x) => x.active && x.code !== "en")) {
      const d = buildLanguageDirective(l.code)!;
      expect(d).toContain(`preferred language is ${l.nameNative}.`);
    }
  });
});

// ─── TTS model routing ───────────────────────────────────────────────────────

describe("TTS model per language", () => {
  it("English and inactive languages keep the flash model; active non-English uses multilingual v2", () => {
    expect(ttsModelForLanguage("en")).toBe("eleven_flash_v2_5");
    expect(ttsModelForLanguage(null)).toBe("eleven_flash_v2_5");
    expect(ttsModelForLanguage("fi")).toBe("eleven_flash_v2_5"); // inactive → English conversation
    for (const l of LANGUAGES.filter((x) => x.active && x.code !== "en")) {
      expect(ttsModelForLanguage(l.code), l.code).toBe("eleven_multilingual_v2");
    }
  });
});

// ─── Catalog coverage for every (language, gender) combo ─────────────────────

describe("voice catalog — non-English coverage", () => {
  it("every active non-English language has ≥3 voices per gender with native previews", () => {
    const englishPreviews = new Set(
      voicesFor("en", "us", "nonbinary").map((v) => v.previewSample),
    );
    for (const l of LANGUAGES.filter((x) => x.active && x.code !== "en")) {
      for (const gender of ["female", "male"] as const) {
        const voices = voicesFor(l.code, "std", gender);
        expect(voices.length, `${l.code}/${gender}`).toBeGreaterThanOrEqual(3);
        for (const v of voices) {
          expect(v.voiceId.length, `${l.code}/${gender}`).toBeGreaterThan(10);
          expect(v.displayName.length, `${l.code}/${gender}`).toBeGreaterThan(3);
          expect(v.previewSample.length, `${l.code}/${gender}`).toBeGreaterThan(10);
          // Preview must be in the target language, not recycled English.
          expect(englishPreviews.has(v.previewSample), `${l.code} preview is English`).toBe(false);
        }
      }
    }
  });
});

// ─── End-to-end: German user ─────────────────────────────────────────────────

async function makeGermanUser(tag: string) {
  const email = `crisis-i18n-${tag}-${Date.now()}@example.invalid`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile");
  await pool.query(
    "UPDATE profile SET preferred_language='de', country='DE', is_onboarding_complete=TRUE WHERE user_id=$1",
    [userId],
  );
  return { agent, userId };
}

describe("end-to-end — German user", () => {
  it("benign German message: no crisis artifacts; removed language means the plain English prompt", async () => {
    const { agent, userId } = await makeGermanUser("benign");

    const res = await agent.post("/api/chat/send").send({ content: "ich fühle mich so allein heute" });
    expect(res.status).toBe(200);
    expect(res.body.crisisHelplineBlock).toBeUndefined();
    expect(
      (await pool.query("SELECT COUNT(*)::int AS n FROM crisis_events WHERE user_id=$1", [userId]))
        .rows[0].n,
    ).toBe(0);

    // German is a REMOVED language (sunset to en+es): a row still storing
    // 'de' (pre-backfill) gets the plain English prompt — no directive. The
    // boot backfill (languageSunset.ts) moves such rows to 'en' anyway.
    const [profile] = await db.select().from(profileTable).where(eq(profileTable.userId, userId));
    const prompt = await buildSystemPrompt(profile!);
    expect(prompt.stable).not.toContain("The user's preferred language is Deutsch.");
  });

  it("German crisis message: detector fires, German helpline card with German lines", async () => {
    const { agent, userId } = await makeGermanUser("crisis");

    const res = await agent.post("/api/chat/send").send({ content: "ich will nicht mehr leben" });
    expect(res.status).toBe(200);
    expect(res.body.crisisHelplineBlock).toBeDefined();
    // German intro + German outro + Germany's helpline (country=DE).
    expect(res.body.crisisHelplineBlock.startsWith("—\nJemand, der jetzt")).toBe(true);
    expect(res.body.crisisHelplineBlock).toContain("TelefonSeelsorge");
    expect(res.body.crisisHelplineBlock.endsWith("Lass dir Zeit.")).toBe(true);
    expect(res.body.assistantMessage.content).toContain("Jemand, der jetzt");

    const events = await pool.query(
      "SELECT pattern_matched, country_served FROM crisis_events WHERE user_id=$1",
      [userId],
    );
    expect(events.rows).toHaveLength(1);
    // pattern_matched is encrypted at rest — raw SQL returns ciphertext.
    expect(isEncrypted(events.rows[0].pattern_matched)).toBe(true);
    expect(
      decryptText(events.rows[0].pattern_matched, "crisis_events.pattern_matched").startsWith("de_"),
    ).toBe(true);
    expect(events.rows[0].country_served).toBe("DE");
  });

  it("an English-only user is untouched: English card, English patterns", async () => {
    const email = `crisis-i18n-en-${Date.now()}@example.invalid`;
    createdEmails.push(email);
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    const userId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    await agent.get("/api/profile");

    // The German phrase does NOT fire for an English-language user…
    const benign = await agent.post("/api/chat/send").send({ content: "ich will nicht mehr leben" });
    expect(benign.body.crisisHelplineBlock).toBeUndefined();
    // …and the English floor behaves exactly as before.
    const crisis = await agent.post("/api/chat/send").send({ content: "I want to die" });
    expect(crisis.body.crisisHelplineBlock).toBeDefined();
    expect(crisis.body.crisisHelplineBlock.startsWith("—\nSomeone who can be with you")).toBe(true);
  });
});
