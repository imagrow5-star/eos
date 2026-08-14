import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { profileTable } from "@workspace/db";
import type { Profile } from "@workspace/db";
import {
  GetProfileResponse,
  UpdateProfileBody,
  UpdateProfileResponse,
} from "@workspace/api-zod";
import { calculateStage } from "../services/stage.js";
import { todayString } from "../services/stage.js";
import { ensureProfileThemeColumns, isMissingThemeColumnError } from "../services/schemaGuard.js";
import { logger } from "../lib/logger.js";
import { sanitizeGenderWords } from "../services/systemPrompt.js";
import { ageToBand, normalizeCountryForStorage, AGE_BANDS } from "../lib/basics.js";

const router: IRouter = Router();

// ─── Shared helper — exported so chat/onboarding/journey can import ───────────

export async function getOrCreateProfileForUser(userId: number): Promise<Profile> {
  try {
    return await readOrCreateProfile(userId);
  } catch (e) {
    // A database that predates the theme columns makes every profile SELECT
    // throw 42703 — which used to hard-block login ("We couldn't load your
    // profile"). Apply the idempotent guard and retry once; a theme column
    // must never lock a user out. Anything else rethrows untouched.
    if (!isMissingThemeColumnError(e)) throw e;
    logger.warn(
      { err: e },
      "profile read hit missing theme columns — applying schema guard and retrying",
    );
    await ensureProfileThemeColumns();
    return await readOrCreateProfile(userId);
  }
}

async function readOrCreateProfile(userId: number): Promise<Profile> {
  const [existing] = await db
    .select()
    .from(profileTable)
    .where(eq(profileTable.userId, userId))
    .limit(1);
  if (existing) return existing;

  // No row yet. There is no unique constraint on profile.user_id, so two
  // concurrent first requests used to race past the SELECT above and each
  // insert a row (seen in production: two rows created 2ms apart). Serialize
  // creation per user with a transaction-scoped advisory lock, and re-check
  // inside the lock before inserting.
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(917501, ${userId})`);

    const [row] = await tx
      .select()
      .from(profileTable)
      .where(eq(profileTable.userId, userId))
      .limit(1);
    if (row) return row;

    const [created] = await tx
      .insert(profileTable)
      .values({ userId, userName: "", companionName: "Eos" })
      .returning();
    return created!;
  });
}

async function recordVisit(profileId: number, userId: number, currentVisitDates: string[]) {
  const today = todayString();
  if (!currentVisitDates.includes(today)) {
    const updated = [...currentVisitDates, today];
    await db
      .update(profileTable)
      .set({ visitDates: updated })
      .where(and(eq(profileTable.id, profileId), eq(profileTable.userId, userId)));
    return updated;
  }
  return currentVisitDates;
}

function buildProfilePayload(
  profile: Profile,
  daysSinceStart: number,
  stage: number,
) {
  return {
    id: profile.id,
    userName: profile.userName,
    companionName: profile.companionName,
    relationshipType: profile.relationshipType,
    energy: profile.energy,
    userPath: profile.userPath,
    country: profile.country,
    ageBand: profile.ageBand ?? "",
    voiceId: profile.voiceId ?? "EXAVITQu4vr4xnSDxMaL",
    voiceTone: (profile as any).voiceTone ?? "auto",
    companionGender: (profile as any).companionGender ?? "woman",
    userGender: (profile as any).userGender ?? null,
    userGenderCustom: (profile as any).userGenderCustom ?? null,
    birthYear: (profile as any).birthYear ?? null,
    ageYears: (profile as any).birthYear
      ? new Date().getFullYear() - (profile as any).birthYear
      : null,
    timezone: (profile as any).timezone ?? "UTC",
    theme: (profile as any).theme ?? null,
    themeMode: (profile as any).themeMode ?? null,
    pushOptIn: (profile as any).pushOptIn ?? false,
    consentVersion: (profile as any).consentVersion ?? null,
    consentAt: (profile as any).consentAt ?? null,
    dataSharingOptIn: (profile as any).dataSharingOptIn ?? false,
    createdAt: profile.createdAt,
    daysSinceStart,
    currentStage: stage,
  };
}

// ─── Consent (Phase A privacy) ────────────────────────────────────────────────
// Records WHICH consent copy the user accepted and WHEN (server clock — never
// trust a client timestamp). Idempotent: accepting a newer version overwrites.
// dataSharingOptIn is a placeholder for any future sharing feature: nothing is
// shared today, and it only ever becomes true by explicit opt-in here or in
// settings — never by default.
router.post("/profile/consent", async (req, res): Promise<void> => {
  const userId = req.userId;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!version || version.length > 64) {
    res.status(400).json({ error: "version is required" });
    return;
  }
  const dataSharingOptIn = body.dataSharingOptIn === true;

  const profile = await getOrCreateProfileForUser(userId);
  const [updated] = await db
    .update(profileTable)
    .set({ consentVersion: version, consentAt: new Date(), dataSharingOptIn } as any)
    .where(eq(profileTable.id, profile.id))
    .returning();
  res.json({
    ok: true,
    consentVersion: (updated as any).consentVersion,
    consentAt: (updated as any).consentAt,
    dataSharingOptIn: (updated as any).dataSharingOptIn,
  });
});

router.get("/profile", async (req, res): Promise<void> => {
  const userId = req.userId;
  let profile = await getOrCreateProfileForUser(userId);
  profile.visitDates = await recordVisit(profile.id, userId, profile.visitDates);

  const stage = await calculateStage(profile);
  const daysSinceStart = Math.floor(
    (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  res.json(GetProfileResponse.parse(buildProfilePayload(profile, daysSinceStart, stage)));
});

router.put("/profile", async (req, res): Promise<void> => {
  const userId = req.userId;
  const parsed = UpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const profile = await getOrCreateProfileForUser(userId);
  const updates: Partial<typeof profileTable.$inferInsert> = {};
  const data = parsed.data;

  if (data.userName != null) updates.userName = data.userName;
  if (data.companionName != null) updates.companionName = data.companionName;
  if (data.relationshipType != null) updates.relationshipType = data.relationshipType;
  if (data.energy != null) updates.energy = data.energy;
  if (data.userPath != null) updates.userPath = data.userPath;
  // country: an ISO-3166 alpha-2 code ("UK" stored for GB), the literal
  // "other", or "" to clear back to "not shared". Legacy superseded codes
  // (SU, ZR, BU, …) are normalized to their canonical modern code so the
  // daily-email timezone fallback stays trustworthy. Anything else is a hard
  // validation error — garbage must never reach the database.
  if (data.country != null) {
    const normalized = normalizeCountryForStorage(String(data.country));
    if (normalized === null) {
      res.status(400).json({
        error: `Invalid country code "${String(data.country)}". Use a two-letter country code (e.g. "IN", "UK"), "other", or "" to clear.`,
      });
      return;
    }
    updates.country = normalized;
  }
  // ageBand: legacy surface — only the four known bands (or "" to clear) may
  // ever be stored. ageBand reaches system prompts, so free text must never
  // land here; prefer ageYears below, which derives the band.
  if ((data as any).ageBand != null) {
    const b = String((data as any).ageBand).trim();
    if (b === "" || (AGE_BANDS as readonly string[]).includes(b)) updates.ageBand = b;
  }
  if ((data as any).voiceId != null) updates.voiceId = (data as any).voiceId;
  if (
    (data as any).voiceTone != null &&
    ["auto", "gentle", "calm", "upbeat"].includes((data as any).voiceTone)
  ) {
    updates.voiceTone = (data as any).voiceTone;
  }
  if ((data as any).companionGender != null) updates.companionGender = (data as any).companionGender;
  // userGender: "man" | "woman" | "custom" — or "" to clear (back to "not shared").
  // Legacy rows may hold "other"; new writes are constrained to the three values.
  if ((data as any).userGender != null) {
    const g = String((data as any).userGender).trim().toLowerCase();
    if (g === "") {
      updates.userGender = null;
      updates.userGenderCustom = null;
    } else if (["man", "woman", "custom"].includes(g)) {
      updates.userGender = g;
      if (g !== "custom") updates.userGenderCustom = null; // presets clear stale custom words
    }
  }
  if ((data as any).userGenderCustom != null) {
    // Custom words may only persist alongside userGender === "custom" — whatever
    // this request (or the stored row) says the gender is after this update.
    // A combined payload like { userGender: "man", userGenderCustom: "…" } must
    // never leave incoherent state behind.
    const effectiveGender =
      "userGender" in updates ? updates.userGender : (profile as any).userGender;
    if (effectiveGender === "custom") {
      const words = sanitizeGenderWords(String((data as any).userGenderCustom));
      updates.userGenderCustom = words === "" ? null : words;
    }
  }
  // ageYears: 18–120 — or "" / 0 to clear. Stored as birthYear so it stays
  // truthful over the years; ageBand is derived alongside for older surfaces.
  // Under-18 values are never stored — the UI explains kindly.
  if ((data as any).ageYears != null) {
    const raw = (data as any).ageYears;
    if (raw === "" || raw === 0 || raw === "0") {
      updates.birthYear = null;
      updates.ageBand = "";
    } else {
      const age = Math.floor(Number(raw));
      if (Number.isFinite(age) && age >= 18 && age <= 120) {
        updates.birthYear = new Date().getFullYear() - age;
        updates.ageBand = ageToBand(age);
      }
    }
  }
  if ((data as any).timezone != null) updates.timezone = (data as any).timezone;
  // Appearance — strict whitelists; anything else is silently ignored so a
  // stale client can never write garbage the CSS doesn't know.
  if (
    (data as any).theme != null &&
    ["dawn", "sage", "twilight"].includes((data as any).theme)
  ) {
    updates.theme = (data as any).theme;
  }
  if (
    (data as any).themeMode != null &&
    ["light", "dark"].includes((data as any).themeMode)
  ) {
    updates.themeMode = (data as any).themeMode;
  }

  // Nothing valid to update (empty body, or only rejected values like an
  // unknown voiceTone) — return the current profile unchanged instead of
  // letting drizzle throw "No values to set" (500).
  if (Object.keys(updates).length === 0) {
    const stage = await calculateStage(profile);
    const daysSinceStart = Math.floor(
      (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    res.json(UpdateProfileResponse.parse(buildProfilePayload(profile, daysSinceStart, stage)));
    return;
  }

  const [updated] = await db
    .update(profileTable)
    .set(updates)
    .where(and(eq(profileTable.id, profile.id), eq(profileTable.userId, userId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  const stage = await calculateStage(updated);
  const daysSinceStart = Math.floor(
    (Date.now() - updated.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  res.json(UpdateProfileResponse.parse(buildProfilePayload(updated, daysSinceStart, stage)));
});

export default router;
