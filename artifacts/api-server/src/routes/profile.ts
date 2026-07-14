import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
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

  const [created] = await db
    .insert(profileTable)
    .values({ userId, userName: "", companionName: "Asha" })
    .returning();
  return created!;
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
  if ((data as any).companionGender != null) updates.companionGender = (data as any).companionGender;
  if ((data as any).userGender != null) updates.userGender = (data as any).userGender;
  if ((data as any).timezone != null) updates.timezone = (data as any).timezone;

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
