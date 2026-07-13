import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { profileTable } from "@workspace/db";
import {
  GetProfileResponse,
  UpdateProfileBody,
  UpdateProfileResponse,
} from "@workspace/api-zod";
import { calculateStage } from "../services/stage.js";
import { todayString } from "../services/stage.js";

const router: IRouter = Router();

async function getOrCreateProfile() {
  const profiles = await db.select().from(profileTable).limit(1);
  if (profiles.length > 0) return profiles[0]!;
  const [profile] = await db
    .insert(profileTable)
    .values({ userName: "", companionName: "Aanya" })
    .returning();
  return profile!;
}

async function recordVisit(profileId: number, currentVisitDates: string[]) {
  const today = todayString();
  if (!currentVisitDates.includes(today)) {
    const updated = [...currentVisitDates, today];
    await db
      .update(profileTable)
      .set({ visitDates: updated })
      .where(eq(profileTable.id, profileId));
    return updated;
  }
  return currentVisitDates;
}

router.get("/profile", async (req, res): Promise<void> => {
  let profile = await getOrCreateProfile();
  profile.visitDates = await recordVisit(profile.id, profile.visitDates);

  const stage = await calculateStage(profile);
  const daysSinceStart = Math.floor(
    (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  res.json(
    GetProfileResponse.parse({
      id: profile.id,
      userName: profile.userName,
      companionName: profile.companionName,
      relationshipType: profile.relationshipType,
      energy: profile.energy,
      createdAt: profile.createdAt,
      daysSinceStart,
      currentStage: stage,
    }),
  );
});

router.put("/profile", async (req, res): Promise<void> => {
  const parsed = UpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const profile = await getOrCreateProfile();
  const updates: Partial<typeof profileTable.$inferInsert> = {};
  const data = parsed.data;

  if (data.userName != null) updates.userName = data.userName;
  if (data.companionName != null) updates.companionName = data.companionName;
  if (data.relationshipType != null) updates.relationshipType = data.relationshipType;
  if (data.energy != null) updates.energy = data.energy;

  const [updated] = await db
    .update(profileTable)
    .set(updates)
    .where(eq(profileTable.id, profile.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  const stage = await calculateStage(updated);
  const daysSinceStart = Math.floor(
    (Date.now() - updated.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  res.json(
    UpdateProfileResponse.parse({
      id: updated.id,
      userName: updated.userName,
      companionName: updated.companionName,
      relationshipType: updated.relationshipType,
      energy: updated.energy,
      createdAt: updated.createdAt,
      daysSinceStart,
      currentStage: stage,
    }),
  );
});

export { getOrCreateProfile };
export default router;
