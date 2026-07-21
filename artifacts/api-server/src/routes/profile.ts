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

const router: IRouter = Router();

// ─── Shared helper — exported so chat/onboarding/journey can import ───────────

export async function getOrCreateProfileForUser(userId: number): Promise<Profile> {
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
    timezone: (profile as any).timezone ?? "UTC",
    createdAt: profile.createdAt,
    daysSinceStart,
    currentStage: stage,
  };
}

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
  if (data.country != null) updates.country = data.country;
  if ((data as any).ageBand != null) updates.ageBand = (data as any).ageBand;
  if ((data as any).voiceId != null) updates.voiceId = (data as any).voiceId;
  if (
    (data as any).voiceTone != null &&
    ["auto", "gentle", "calm", "upbeat"].includes((data as any).voiceTone)
  ) {
    updates.voiceTone = (data as any).voiceTone;
  }
  if ((data as any).companionGender != null) updates.companionGender = (data as any).companionGender;
  if ((data as any).userGender != null) updates.userGender = (data as any).userGender;
  if ((data as any).timezone != null) updates.timezone = (data as any).timezone;

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
